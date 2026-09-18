// Public - the receiver submits their initials/name/signature. Gated the
// same way esign-get.js is: the record id in the body is the credential.
// Only valid from the "awaiting_receiver" state, so a link can't be replayed
// to overwrite a signature that's already gone back to the preparer.
const { readJsonBody } = require("./_session");
const { getRecord, saveRecord, upsertIndexEntry } = require("./_esign");
const { sendResendEmail } = require("./_resend");

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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  var body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }
  if (!body || !body.id || !body.receiver) {
    res.status(400).json({ error: "Missing id or receiver signature data." });
    return;
  }

  var record;
  try {
    record = await getRecord(body.id);
  } catch (e) {
    res.status(500).json({ error: "Could not load the document: " + (e && e.message ? e.message : String(e)) });
    return;
  }
  if (!record) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  if (record.status !== "awaiting_receiver") {
    res.status(409).json({ error: "This document has already been signed and returned." });
    return;
  }

  var now = new Date().toISOString();
  record.blocks = record.blocks || {};
  record.blocks.receiver = body.receiver;
  // Same person signs both the "approved by" spot and the final signature
  // page - mirror it the way the original client-only prototype did.
  record.blocks.approver = Object.assign({}, record.blocks.approver, {
    nameValue: body.receiver.nameValue,
    initials: body.receiver.initials,
    sigDataUrl: body.receiver.sigDataUrl,
    hasStrokes: body.receiver.hasStrokes,
    signedAt: body.receiver.signedAt
  });
  record.status = "receiver_signed";
  record.receiverSignedAt = now;

  var emailResult = { sent: false, reason: "no-address" };
  if (record.preparerEmail) {
    var link = baseUrl(req) + "/esign.html?id=" + record.id;
    var subject = "Signed & returned: " + record.fileName;
    var name = (body.receiver && body.receiver.nameValue) || "The receiver";
    var html =
      "<div style=\"font-family:sans-serif;color:#222;\">" +
      "<p>Hi,</p>" +
      "<p><b>" + escapeHtml(name) + "</b> has signed and returned <b>" + escapeHtml(record.fileName) + "</b>.</p>" +
      "<p><a href=\"" + link + "\" style=\"display:inline-block;padding:10px 18px;background:#2952e3;color:#fff;text-decoration:none;border-radius:6px;\">Review &amp; finalize</a></p>" +
      "<p style=\"color:#888;font-size:12px;\">Or copy this link: " + link + "</p>" +
      "</div>";
    var text = name + " has signed and returned \"" + record.fileName + "\".\n\nOpen this link to review and finalize:\n" + link;
    emailResult = await sendResendEmail({ to: record.preparerEmail, subject: subject, html: html, text: text });
    record.emailLog.push({ to: record.preparerEmail, subject: subject, sent: emailResult.sent, reason: emailResult.reason || null, resendId: emailResult.id || null, at: now });
  }

  try {
    await saveRecord(record);
    await upsertIndexEntry({ id: record.id, status: record.status });
  } catch (e) {
    res.status(500).json({ error: "Could not save your signature: " + (e && e.message ? e.message : String(e)) });
    return;
  }

  res.status(200).json({ ok: true, emailSent: emailResult.sent, emailReason: emailResult.reason || null });
};
