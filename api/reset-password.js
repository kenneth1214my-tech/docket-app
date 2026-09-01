// The "forgot password" recovery path - no session required, since being
// locked out is exactly the scenario this exists for. Authorized instead
// by TEAM_LOGIN_PASSWORD, which only the Vercel project owner can look up
// (Project Settings > Environment Variables), acting as an admin master
// key rather than the day-to-day login password once one has been set.
const { Redis } = require("@upstash/redis");
const { issueCookie, readJsonBody, hashPassword } = require("./_session");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
var PASSWORD_KEY = "docket:password_hash";

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

  var recoveryCode = process.env.TEAM_LOGIN_PASSWORD;
  if (!recoveryCode || !body || body.recoveryCode !== recoveryCode) {
    res.status(401).json({ error: "Incorrect recovery code." });
    return;
  }
  if (!body.newPassword || String(body.newPassword).length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters." });
    return;
  }

  try {
    await redis.set(PASSWORD_KEY, hashPassword(body.newPassword));
    issueCookie(res);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not reset password: " + (e && e.message ? e.message : String(e)) });
  }
};
