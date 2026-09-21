// Single dispatcher for every e-signature operation (create/get/submit/
// finalize/list/cancel), routed by ?action= (GET) or body.action (POST).
// Consolidated into one file - not six - because this project is on
// Vercel's Hobby plan, which caps a deployment at 12 Serverless Functions;
// the rest of api/ already uses 9 of those, so one shared route was needed
// rather than one function per operation.
const { requireSession, readJsonBody } = require("./_session");
const { newId, getRecord, saveRecord, getIndex, upsertIndexEntry, removeIndexEntry } = require("./_esign");
const { sendResendEmail } = require("./_resend");
const { Redis } = require("@upstash/redis");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function baseUrl(req) {
  var proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  var host = req.headers["x-forwarded-host"] || req.headers.host;
  return proto + "://" + host;
}

// ---- action handlers ----

async function actionCreate(req, res) {
  var session = requireSession(req, res);
  if (!session) return;
  var body;
  try { body = await readJsonBody(req); } catch (e) { res.status(400).json({ error: "Invalid request body." }); return; }
  if (!body || !body.fileName || !body.originalBlobUrl || !Array.isArray(body.pageIncluded)) {
    res.status(400).json({ error: "Missing required fields (fileName, originalBlobUrl, pageIncluded)." });
    return;
  }
  var receiverEmail = String(body.receiverEmail || "").trim();
  if (!receiverEmail) { res.status(400).json({ error: "A receiver email is required." }); return; }

  var now = new Date().toISOString();
  var record = {
    id: newId(), status: "awaiting_receiver",
    fileName: body.fileName, pageCount: body.pageCount || body.pageIncluded.length, fileHashHex: body.fileHashHex || null,
    originalBlobUrl: body.originalBlobUrl, finalBlobUrl: null,
    pageIncluded: body.pageIncluded, includePageStamp: body.includePageStamp !== false, blocks: body.blocks || {},
    receiverEmail: receiverEmail, preparerEmail: String(body.preparerEmail || session.email || "").trim() || null,
    preparerId: session.sub, preparerName: session.name || null,
    createdAt: now, sentAt: null, receiverSignedAt: null, completedAt: null, emailLog: []
  };

  var link = baseUrl(req) + "/esign.html?id=" + record.id;
  var subject = String(body.subject || "").trim() || ("Please sign: " + record.fileName);
  var message = String(body.message || "").trim() ||
    ((record.preparerName || "A Docket user") + " has sent you a document to review and sign: " + record.fileName + ".");
  record.emailSubject = subject; record.emailMessage = message; // kept for the review screen if the request is edited later
  var html =
    "<div style=\"font-family:sans-serif;color:#222;\"><p>Hi,</p>" +
    "<p>" + escapeHtml(message).replace(/\n/g, "<br>") + "</p>" +
    "<p><a href=\"" + link + "\" style=\"display:inline-block;padding:10px 18px;background:#2952e3;color:#fff;text-decoration:none;border-radius:6px;\">Open &amp; sign</a></p>" +
    "<p style=\"color:#888;font-size:12px;\">Or copy this link: " + link + "</p></div>";
  var text = message + "\n\nOpen this link to sign it:\n" + link;

  var emailResult = await sendResendEmail({ to: receiverEmail, subject: subject, html: html, text: text });
  record.sentAt = now;
  record.emailLog.push({ to: receiverEmail, subject: subject, sent: emailResult.sent, reason: emailResult.reason || null, resendId: emailResult.id || null, at: now });

  try {
    await saveRecord(record);
    await upsertIndexEntry({ id: record.id, fileName: record.fileName, receiverEmail: record.receiverEmail, status: record.status, preparerId: record.preparerId, preparerName: record.preparerName, createdAt: record.createdAt });
  } catch (e) { res.status(500).json({ error: "Could not save the signing request: " + (e && e.message ? e.message : String(e)) }); return; }

  res.status(200).json({ id: record.id, link: link, emailSent: emailResult.sent, emailReason: emailResult.reason || null });
}

async function actionGet(req, res) {
  var id = req.query && req.query.id;
  if (!id) { res.status(400).json({ error: "Missing id." }); return; }
  try {
    var record = await getRecord(id);
    if (!record) { res.status(404).json({ error: "Not found." }); return; }
    res.status(200).json(record);
  } catch (e) { res.status(500).json({ error: "Could not load the document: " + (e && e.message ? e.message : String(e)) }); }
}

async function actionSubmit(req, res) {
  var body;
  try { body = await readJsonBody(req); } catch (e) { res.status(400).json({ error: "Invalid request body." }); return; }
  if (!body || !body.id || !body.receiver) { res.status(400).json({ error: "Missing id or receiver signature data." }); return; }

  var record;
  try { record = await getRecord(body.id); } catch (e) { res.status(500).json({ error: "Could not load the document: " + (e && e.message ? e.message : String(e)) }); return; }
  if (!record) { res.status(404).json({ error: "Not found." }); return; }
  if (record.status !== "awaiting_receiver") { res.status(409).json({ error: "This document has already been signed and returned." }); return; }

  var now = new Date().toISOString();
  record.blocks = record.blocks || {};
  record.blocks.receiver = body.receiver;
  record.blocks.approver = Object.assign({}, record.blocks.approver, {
    nameValue: body.receiver.nameValue, initials: body.receiver.initials, sigDataUrl: body.receiver.sigDataUrl,
    hasStrokes: body.receiver.hasStrokes, signedAt: body.receiver.signedAt
  });
  record.status = "receiver_signed";
  record.receiverSignedAt = now;

  var emailResult = { sent: false, reason: "no-address" };
  if (record.preparerEmail) {
    var link = baseUrl(req) + "/esign.html?id=" + record.id;
    var subject = "Signed & returned: " + record.fileName;
    var name = (body.receiver && body.receiver.nameValue) || "The receiver";
    var html =
      "<div style=\"font-family:sans-serif;color:#222;\"><p>Hi,</p>" +
      "<p><b>" + escapeHtml(name) + "</b> has signed and returned <b>" + escapeHtml(record.fileName) + "</b>.</p>" +
      "<p><a href=\"" + link + "\" style=\"display:inline-block;padding:10px 18px;background:#2952e3;color:#fff;text-decoration:none;border-radius:6px;\">Review &amp; finalize</a></p>" +
      "<p style=\"color:#888;font-size:12px;\">Or copy this link: " + link + "</p></div>";
    var text = name + " has signed and returned \"" + record.fileName + "\".\n\nOpen this link to review and finalize:\n" + link;
    emailResult = await sendResendEmail({ to: record.preparerEmail, subject: subject, html: html, text: text });
    record.emailLog.push({ to: record.preparerEmail, subject: subject, sent: emailResult.sent, reason: emailResult.reason || null, resendId: emailResult.id || null, at: now });
  }

  try { await saveRecord(record); await upsertIndexEntry({ id: record.id, status: record.status }); }
  catch (e) { res.status(500).json({ error: "Could not save your signature: " + (e && e.message ? e.message : String(e)) }); return; }

  res.status(200).json({ ok: true, emailSent: emailResult.sent, emailReason: emailResult.reason || null });
}

async function actionFinalize(req, res) {
  var session = requireSession(req, res);
  if (!session) return;
  var body;
  try { body = await readJsonBody(req); } catch (e) { res.status(400).json({ error: "Invalid request body." }); return; }
  if (!body || !body.id || !body.finalBlobUrl) { res.status(400).json({ error: "Missing id or finalBlobUrl." }); return; }

  var record;
  try { record = await getRecord(body.id); } catch (e) { res.status(500).json({ error: "Could not load the document: " + (e && e.message ? e.message : String(e)) }); return; }
  if (!record) { res.status(404).json({ error: "Not found." }); return; }
  if (record.status !== "receiver_signed") { res.status(409).json({ error: "This document isn't ready to finalize yet." }); return; }

  var now = new Date().toISOString();
  record.status = "completed";
  record.finalBlobUrl = body.finalBlobUrl;
  record.completionId = body.completionId || null;
  record.completedAt = now;

  var emailResult = { sent: false, reason: "no-address" };
  if (record.receiverEmail) {
    var link = baseUrl(req) + "/esign.html?id=" + record.id;
    var subject = "Your signed copy: " + record.fileName;
    var html =
      "<div style=\"font-family:sans-serif;color:#222;\"><p>Hi,</p>" +
      "<p>The document <b>" + escapeHtml(record.fileName) + "</b> has been finalized and locked.</p>" +
      "<p><a href=\"" + link + "\" style=\"display:inline-block;padding:10px 18px;background:#2952e3;color:#fff;text-decoration:none;border-radius:6px;\">Download your copy</a></p>" +
      "<p style=\"color:#888;font-size:12px;\">Or copy this link: " + link + "</p></div>";
    var text = "The document has been finalized. You can download your copy here:\n" + link;
    emailResult = await sendResendEmail({ to: record.receiverEmail, subject: subject, html: html, text: text });
    record.emailLog.push({ to: record.receiverEmail, subject: subject, sent: emailResult.sent, reason: emailResult.reason || null, resendId: emailResult.id || null, at: now });
  }

  try { await saveRecord(record); await upsertIndexEntry({ id: record.id, status: record.status }); }
  catch (e) { res.status(500).json({ error: "Could not save the final document: " + (e && e.message ? e.message : String(e)) }); return; }

  res.status(200).json({ ok: true, emailSent: emailResult.sent, emailReason: emailResult.reason || null });
}

async function actionList(req, res) {
  var session = requireSession(req, res);
  if (!session) return;
  try {
    var idx = await getIndex();
    res.status(200).json({ documents: idx });
  } catch (e) { res.status(500).json({ error: "Could not load documents: " + (e && e.message ? e.message : String(e)) }); }
}

async function actionCancel(req, res) {
  var session = requireSession(req, res);
  if (!session) return;
  var body;
  try { body = await readJsonBody(req); } catch (e) { res.status(400).json({ error: "Invalid request body." }); return; }
  if (!body || !body.id) { res.status(400).json({ error: "Missing id." }); return; }
  try {
    var record = await getRecord(body.id);
    if (!record) { res.status(404).json({ error: "Not found." }); return; }
    await redis.del("docket:esign:" + body.id);
    await removeIndexEntry(body.id);
    res.status(200).json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not cancel: " + (e && e.message ? e.message : String(e)) }); }
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    var action = req.query && req.query.action;
    if (action === "list") return actionList(req, res);
    return actionGet(req, res); // default GET action: fetch one record by ?id=
  }
  if (req.method === "POST") {
    var body;
    try { body = await readJsonBody(req); } catch (e) { res.status(400).json({ error: "Invalid request body." }); return; }
    var actionHandlers = { create: actionCreate, submit: actionSubmit, finalize: actionFinalize, cancel: actionCancel };
    var handler = actionHandlers[body && body.action];
    if (!handler) { res.status(400).json({ error: "Unknown or missing action." }); return; }
    // Each handler calls readJsonBody(req) itself; re-attach the already
    // parsed body first so that call hits its req.body fast path instead of
    // trying to read the (already consumed) request stream a second time.
    req.body = body;
    return handler(req, res);
  }
  res.status(405).json({ error: "Method not allowed" });
};
