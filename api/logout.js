const { clearCookie } = require("./_session");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  clearCookie(res);
  res.status(200).json({ ok: true });
};
