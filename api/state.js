// The whole team's shared contract register, stored as one JSON blob in
// Upstash Redis - deliberately the same shape the client used to keep in
// localStorage. This is the smallest change that gets the data off of one
// browser: no schema redesign, just a different place to read/write the
// same object. Gated by the single shared-team-login session cookie.
const { Redis } = require("@upstash/redis");
const { requireSession, readJsonBody } = require("./_session");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
var STATE_KEY = "docket:state";

module.exports = async (req, res) => {
  var session = requireSession(req, res);
  if (!session) return;

  if (req.method === "GET") {
    try {
      var data = await redis.get(STATE_KEY);
      res.status(200).json(data || null);
    } catch (e) {
      res.status(500).json({ error: "Could not read data: " + (e && e.message ? e.message : String(e)) });
    }
    return;
  }

  if (req.method === "PUT") {
    var body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      res.status(400).json({ error: "Invalid request body." });
      return;
    }
    if (!body || !Array.isArray(body.contracts)) {
      res.status(400).json({ error: "Invalid state shape - expected { contracts: [...] }." });
      return;
    }
    try {
      await redis.set(STATE_KEY, body);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Could not save data: " + (e && e.message ? e.message : String(e)) });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
