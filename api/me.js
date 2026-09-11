// Tells the client who's currently logged in - called once right after
// boot so the UI knows the display name/role for "created by" tracking and
// for hiding admin-only actions from members.
const { requireSession } = require("./_session");

module.exports = async (req, res) => {
  var session = requireSession(req, res);
  if (!session) return;
  res.status(200).json({ id: session.sub, email: session.email, name: session.name, role: session.role, emergency: session.sub === "emergency" });
};
