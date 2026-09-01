// Requires an active session - this is "I'm logged in and want to set a
// new shared password," not the recovery flow (see reset-password.js).
const { Redis } = require("@upstash/redis");
const { requireSession, readJsonBody, hashPassword, verifyPassword } = require("./_session");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
var PASSWORD_KEY = "docket:password_hash";

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
  if (!body || !body.currentPassword || !body.newPassword) {
    res.status(400).json({ error: "Enter your current and new password." });
    return;
  }
  if (String(body.newPassword).length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters." });
    return;
  }

  try {
    var stored = await redis.get(PASSWORD_KEY);
    var currentOk = stored ? verifyPassword(body.currentPassword, stored) : body.currentPassword === process.env.TEAM_LOGIN_PASSWORD;
    if (!currentOk) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    await redis.set(PASSWORD_KEY, hashPassword(body.newPassword));
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not change password: " + (e && e.message ? e.message : String(e)) });
  }
};
