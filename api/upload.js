// Issues short-lived client tokens for Vercel Blob "client uploads" - the
// browser uploads the file bytes directly to Blob storage, never through
// this function. This is required, not optional: Vercel serverless
// functions hard-cap request bodies at ~4.5MB, and real scanned contracts
// (photographed leases, multi-page agreements) routinely exceed that.
const { handleUpload } = require("@vercel/blob/client");

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp"
];
const MAX_BYTES = 25 * 1024 * 1024; // 25MB - generous for a scanned contract, still a sane cap

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if (!body || typeof body !== "object") {
    // Defensive fallback in case a runtime doesn't auto-parse JSON bodies.
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (e) {
      res.status(400).json({ error: "Invalid request body." });
      return;
    }
  }

  const accessCode = process.env.UPLOAD_ACCESS_CODE;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Same bot/abuse deterrent as before, just checked here instead of
        // via a header - client uploads pass this through clientPayload.
        if (accessCode) {
          let payload = {};
          try { payload = JSON.parse(clientPayload || "{}"); } catch (e) { /* ignore */ }
          if (payload.code !== accessCode) throw new Error("Invalid or missing upload code.");
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true
        };
      },
      onUploadCompleted: async () => {
        // No server-side database to update - the client already receives
        // the blob URL directly from the upload() call and saves it itself.
      }
    });
    res.status(200).json(jsonResponse);
  } catch (error) {
    res.status(400).json({ error: error && error.message ? error.message : String(error) });
  }
};
