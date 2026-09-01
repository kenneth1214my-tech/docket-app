const { Redis } = require("@upstash/redis");
const { issueCookie, readJsonBody, verifyPassword } = require("./_session");

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

  var ok;
  try {
    // Once the team has changed the password at least once (via Change
    // Password), the stored hash is authoritative. Until then, the
    // TEAM_LOGIN_PASSWORD env var is both the default password and - even
    // after it's changed - the recovery code for Forgot Password.
    var stored = await redis.get(PASSWORD_KEY);
    if (stored) {
      ok = verifyPassword(body && body.password, stored);
    } else {
      var fallback = process.env.TEAM_LOGIN_PASSWORD;
      ok = !!fallback && body && body.password === fallback;
    }
  } catch (e) {
    res.status(500).json({ error: "Could not verify password: " + (e && e.message ? e.message : String(e)) });
    return;
  }

  if (!ok) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }

  issueCookie(res);
  res.status(200).json({ ok: true });
};
