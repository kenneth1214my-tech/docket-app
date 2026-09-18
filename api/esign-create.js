// Preparer creates a signing request: the PDF itself is already uploaded to
// Vercel Blob client-side (same flow as everywhere else in this app - see
// upload.js) before this is called, so this endpoint only ever handles a
// small JSON payload. Sends the "please sign" email itself, server-side, and
// reports back the real Resend result instead of assuming it worked.
const { requireSession, readJsonBody } = require("./_session");
const { newId, saveRecord, upsertIndexEntry } = require("./_esign");
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
  var session = requireSession(req, res);
  if (!session) return;

  var body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }

  if (!body || !body.fileName || !body.originalBlobUrl || !Array.isArray(body.pageIncluded)) {
    res.status(400).json({ error: "Missing required fields (fileName, originalBlobUrl, pageIncluded)." });
    return;
  }
  var receiverEmail = String(body.receiverEmail || "").trim();
  if (!receiverEmail) {
    res.status(400).json({ error: "A receiver email is required." });
    return;
  }

  var now = new Date().toISOString();
  var record = {
    id: newId(),
    status: "awaiting_receiver",
    fileName: body.fileName,
    pageCount: body.pageCount || body.pageIncluded.length,
    fileHashHex: body.fileHashHex || null,
    originalBlobUrl: body.originalBlobUrl,
    finalBlobUrl: null,
    pageIncluded: body.pageIncluded,
    includePageStamp: body.includePageStamp !== false,
    blocks: body.blocks || {},
    receiverEmail: receiverEmail,
    preparerEmail: String(body.preparerEmail || session.email || "").trim() || null,
    preparerId: session.sub,
    preparerName: session.name || null,
    createdAt: now,
    sentAt: null,
    receiverSignedAt: null,
    completedAt: null,
    emailLog: []
  };

  var link = baseUrl(req) + "/esign.html?id=" + record.id;
  var subject = "Please sign: " + record.fileName;
  var html =
    "<div style=\"font-family:sans-serif;color:#222;\">" +
    "<p>Hi,</p>" +
    "<p>" + escapeHtml(record.preparerName || "A Docket user") + " has sent you a document to review and sign: <b>" + escapeHtml(record.fileName) + "</b>.</p>" +
    "<p><a href=\"" + link + "\" style=\"display:inline-block;padding:10px 18px;background:#2952e3;color:#fff;text-decoration:none;border-radius:6px;\">Open &amp; sign</a></p>" +
    "<p style=\"color:#888;font-size:12px;\">Or copy this link: " + link + "</p>" +
    "</div>";
  var text = "Please review and sign: " + record.fileName + "\n\nOpen this link to sign it:\n" + link;

  var emailResult = await sendResendEmail({ to: receiverEmail, subject: subject, html: html, text: text });
  record.sentAt = now;
  record.emailLog.push({ to: receiverEmail, subject: subject, sent: emailResult.sent, reason: emailResult.reason || null, resendId: emailResult.id || null, at: now });

  try {
    await saveRecord(record);
    await upsertIndexEntry({
      id: record.id,
      fileName: record.fileName,
      receiverEmail: record.receiverEmail,
      status: record.status,
      preparerId: record.preparerId,
      preparerName: record.preparerName,
      createdAt: record.createdAt
    });
  } catch (e) {
    res.status(500).json({ error: "Could not save the signing request: " + (e && e.message ? e.message : String(e)) });
    return;
  }

  res.status(200).json({ id: record.id, link: link, emailSent: emailResult.sent, emailReason: emailResult.reason || null });
};
