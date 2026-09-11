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
      // The client always PUTs the whole blob (no per-record endpoints), so
      // this is the only place that can actually tell "did something get
      // deleted" - by diffing against what's currently stored. A member's
      // UI already hides delete/clear-all/import, but this is the real
      // enforcement: any contract id present now and missing from the new
      // payload is a deletion, and only admins may make one (this also
      // naturally covers Clear All and Import, both of which drop ids too).
      if (session.role !== "admin") {
        var current = await redis.get(STATE_KEY);
        if (current && Array.isArray(current.contracts)) {
          var newIds = {};
          body.contracts.forEach(function (c) { newIds[c.id] = true; });
          var deleted = current.contracts.some(function (c) { return !newIds[c.id]; });
          if (deleted) {
            res.status(403).json({ error: "Only admins can delete contracts." });
            return;
          }
        }
        // Admin Settings lives in this same blob - a member's save should
        // never be able to smuggle a settings change through, even by
        // accident (e.g. a stale local copy). Keep whatever's already there.
        if (current) body.settings = current.settings;
      }
      await redis.set(STATE_KEY, body);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Could not save data: " + (e && e.message ? e.message : String(e)) });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
