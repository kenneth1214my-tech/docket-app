// Stores the original uploaded contract file in Vercel Blob so it can be
// retrieved later. Nothing else in Docket needs a server - this route
// exists purely so an uploaded PDF/DOCX/image isn't discarded after its
// text is pulled out client-side for extraction.
const { put } = require("@vercel/blob");

const ALLOWED_EXT = ["pdf", "docx", "txt", "jpg", "jpeg", "png", "webp", "bmp"];
const MAX_BYTES = 20 * 1024 * 1024; // 20MB

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Lightweight bot/abuse deterrent, not a real secret: this app has no login,
  // so the code is baked into the public client bundle. It filters out
  // automated scanners hitting the endpoint directly; it does not stop
  // someone who reads the JS. Server-side size/type limits below are the
  // real backstop.
  const accessCode = process.env.UPLOAD_ACCESS_CODE;
  if (accessCode && req.headers["x-upload-code"] !== accessCode) {
    res.status(401).json({ error: "Invalid or missing upload code." });
    return;
  }

  let fileName = "";
  try {
    fileName = decodeURIComponent(req.headers["x-file-name"] || "");
  } catch (e) {
    fileName = "";
  }
  if (!fileName) {
    res.status(400).json({ error: "Missing x-file-name header." });
    return;
  }

  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (ALLOWED_EXT.indexOf(ext) === -1) {
    res.status(400).json({ error: "Unsupported file type." });
    return;
  }

  // bodyParser is disabled below, but some runtimes (notably `vercel dev`
  // locally) pre-drain the stream into req.body regardless - handle both.
  let buffer;
  if (req.body && (Buffer.isBuffer(req.body) || typeof req.body === "string")) {
    buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
  } else {
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BYTES) {
          res.status(413).json({ error: "File too large (max 20MB)." });
          return;
        }
        chunks.push(chunk);
      }
    } catch (e) {
      res.status(400).json({ error: "Could not read upload." });
      return;
    }
    buffer = Buffer.concat(chunks);
  }
  if (!buffer || !buffer.length) {
    res.status(400).json({ error: "Empty file." });
    return;
  }
  if (buffer.length > MAX_BYTES) {
    res.status(413).json({ error: "File too large (max 20MB)." });
    return;
  }

  try {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const blob = await put("contracts/" + Date.now() + "-" + safeName, buffer, {
      access: "public",
      addRandomSuffix: true,
      contentType: req.headers["content-type"] || undefined
    });
    res.status(200).json({ url: blob.url, pathname: blob.pathname, size: buffer.length });
  } catch (e) {
    res.status(500).json({ error: "Upload failed: " + (e && e.message ? e.message : String(e)) });
  }
};

module.exports.config = { api: { bodyParser: false } };
