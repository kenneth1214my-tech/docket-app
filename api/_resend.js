// Shared helper for sending email via Resend. Not a route - "_" prefix
// excludes it from Vercel's file-routing.
//
// Unlike a client-side "send this email" call from inside a browser page
// (which can report success without any verifiable proof a real send
// happened), this runs on the server and inspects Resend's actual HTTP
// response - res.ok and the parsed body are real signal, not a guess. Every
// caller gets back a plain { sent, id, reason } result instead of a thrown
// exception, so a failed send never crashes the request it's part of - the
// caller decides what to do (log it, show it, fall back to a copy-paste box).
async function sendResendEmail({ to, subject, html, text }) {
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: "not_configured" };
  var recipients = Array.isArray(to) ? to : [to];
  try {
    var r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "Docket <onboarding@resend.dev>",
        to: recipients,
        subject: subject,
        html: html,
        text: text
      })
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      return { sent: false, reason: (data && data.message) || (r.status + " " + r.statusText) };
    }
    return { sent: true, id: data && data.id };
  } catch (e) {
    return { sent: false, reason: e && e.message ? e.message : String(e) };
  }
}

module.exports = { sendResendEmail };
