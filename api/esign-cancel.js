// Preparer cancels a pending (or already-signed but not yet finalized)
// request. The receiver's link simply stops resolving to anything useful
// once the record is gone - deleting it is enough, no separate "revoked"
// flag needed.
const { requireSession, readJsonBody } = require("./_session");
const { getRecord, removeIndexEntry } = require("./_esign");
const { Redis } = require("@upstash/redis");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

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
  if (!body || !body.id) {
    res.status(400).json({ error: "Missing id." });
    return;
  }

  try {
    var record = await getRecord(body.id);
    if (!record) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    await redis.del("docket:esign:" + body.id);
    await removeIndexEntry(body.id);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not cancel: " + (e && e.message ? e.message : String(e)) });
  }
};
