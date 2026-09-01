const { issueCookie, readJsonBody } = require("./_session");

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

  var expected = process.env.TEAM_LOGIN_PASSWORD;
  if (!expected) {
    res.status(500).json({ error: "Login is not configured on this deployment." });
    return;
  }
  if (!body || body.password !== expected) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }

  issueCookie(res);
  res.status(200).json({ ok: true });
};
