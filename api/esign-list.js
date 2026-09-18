// Dashboard list for the "prepare a document" side. Requires login - this
// is the same shared-team trust model as the rest of Docket (docket:state),
// so any signed-in member can see every signing request the team has sent,
// not just their own.
const { requireSession } = require("./_session");
const { getIndex } = require("./_esign");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  var session = requireSession(req, res);
  if (!session) return;

  try {
    var idx = await getIndex();
    res.status(200).json({ documents: idx });
  } catch (e) {
    res.status(500).json({ error: "Could not load documents: " + (e && e.message ? e.message : String(e)) });
  }
};
