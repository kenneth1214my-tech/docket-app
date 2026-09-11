const { Redis } = require("@upstash/redis");
const { issueCookie, readJsonBody, verifyPassword } = require("./_session");
const { getUsers, findUserByEmail } = require("./_users");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
var PASSWORD_KEY = "docket:password_hash"; // the old single shared password - kept as an emergency fallback only

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

  // Emergency access: the team's original shared password, unrelated to any
  // personal account. Always available so no one gets permanently locked
  // out, and it's the only way in before any personal accounts exist yet.
  if (body && body.emergencyPassword) {
    var emergencyOk;
    try {
      var stored = await redis.get(PASSWORD_KEY);
      if (stored) {
        emergencyOk = verifyPassword(body.emergencyPassword, stored);
      } else {
        var fallback = process.env.TEAM_LOGIN_PASSWORD;
        emergencyOk = !!fallback && body.emergencyPassword === fallback;
      }
    } catch (e) {
      res.status(500).json({ error: "Could not verify password: " + (e && e.message ? e.message : String(e)) });
      return;
    }
    if (!emergencyOk) {
      res.status(401).json({ error: "Incorrect emergency password." });
      return;
    }
    issueCookie(res, { sub: "emergency", email: null, name: "Emergency Access", role: "admin" });
    res.status(200).json({ ok: true });
    return;
  }

  // Normal per-user login.
  if (!body || !body.email || !body.password) {
    res.status(400).json({ error: "Enter your email and password." });
    return;
  }
  var users;
  try {
    users = await getUsers();
  } catch (e) {
    res.status(500).json({ error: "Could not verify login: " + (e && e.message ? e.message : String(e)) });
    return;
  }
  var user = findUserByEmail(users, body.email);
  if (!user || user.active === false || !verifyPassword(body.password, user.passwordHash)) {
    res.status(401).json({ error: "Incorrect email or password." });
    return;
  }

  issueCookie(res, { sub: user.id, email: user.email, name: user.name, role: user.role });
  res.status(200).json({ ok: true });
};
