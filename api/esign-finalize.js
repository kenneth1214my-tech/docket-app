// Preparer locks the final copy. The flattened PDF (initials baked in,
// signatures drawn, completion certificate appended) is built client-side
// with pdf-lib - same library and approach already used elsewhere in this
// app - then uploaded to Blob the normal way; this endpoint just records the
// result and sends the receiver their copy, server-verified.
const { requireSession, readJsonBody } = require("./_session");
const { getRecord, saveRecord, upsertIndexEntry } = require("./_esign");
const { sendResendEmail } = require("./_resend");

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
  if (!body || !body.id || !body.finalBlobUrl) {
    res.status(400).json({ error: "Missing id or finalBlobUrl." });
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
  if (record.status !== "receiver_signed") {
    res.status(409).json({ error: "This document isn't ready to finalize yet." });
    return;
  }

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
      "<div style=\"font-family:sans-serif;color:#222;\">" +
      "<p>Hi,</p>" +
      "<p>The document <b>" + record.fileName.replace(/[<>&]/g, "") + "</b> has been finalized and locked.</p>" +
      "<p><a href=\"" + link + "\" style=\"display:inline-block;padding:10px 18px;background:#2952e3;color:#fff;text-decoration:none;border-radius:6px;\">Download your copy</a></p>" +
      "<p style=\"color:#888;font-size:12px;\">Or copy this link: " + link + "</p>" +
      "</div>";
    var text = "The document has been finalized. You can download your copy here:\n" + link;
    emailResult = await sendResendEmail({ to: record.receiverEmail, subject: subject, html: html, text: text });
    record.emailLog.push({ to: record.receiverEmail, subject: subject, sent: emailResult.sent, reason: emailResult.reason || null, resendId: emailResult.id || null, at: now });
  }

  try {
    await saveRecord(record);
    await upsertIndexEntry({ id: record.id, status: record.status });
  } catch (e) {
    res.status(500).json({ error: "Could not save the final document: " + (e && e.message ? e.message : String(e)) });
    return;
  }

  res.status(200).json({ ok: true, emailSent: emailResult.sent, emailReason: emailResult.reason || null });
};
