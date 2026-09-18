// Public - deliberately no requireSession. The receiver never logs into
// Docket; the long random id in the URL (see _esign.js newId()) is the only
// credential, the same "unguessable link" trust model this app already uses
// for uploads. Anyone holding the link can view the record and sign it.
const { getRecord } = require("./_esign");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  var id = req.query && req.query.id;
  if (!id) {
    res.status(400).json({ error: "Missing id." });
    return;
  }
  try {
    var record = await getRecord(id);
    if (!record) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    res.status(200).json(record);
  } catch (e) {
    res.status(500).json({ error: "Could not load the document: " + (e && e.message ? e.message : String(e)) });
  }
};
