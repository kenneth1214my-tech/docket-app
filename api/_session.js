// Shared helper for the single-team-login session cookie. Not a route -
// files starting with "_" are excluded from Vercel's /api file-routing.
//
// Stateless signed cookie (HMAC-SHA256), not a session table: this app has
// exactly one shared login for the whole team, not per-user accounts, so
// there is nothing to look up server-side beyond "is this signature valid
// and not expired."
const crypto = require("crypto");

function sign(payload, secret) {
  var data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  var hmac = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return data + "." + hmac;
}

function verify(token, secret) {
  if (!token || typeof token !== "string") return null;
  var parts = token.split(".");
  if (parts.length !== 2) return null;
  var data = parts[0], hmac = parts[1];
  var expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  var a = Buffer.from(hmac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  var payload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function parseCookies(req) {
  var header = (req.headers && req.headers.cookie) || "";
  var out = {};
  header.split(";").forEach(function (part) {
    var idx = part.indexOf("=");
    if (idx === -1) return;
    var k = part.slice(0, idx).trim();
    var v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

var COOKIE_NAME = "docket_session";
var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function issueCookie(res) {
  var token = sign({ exp: Date.now() + MAX_AGE_MS }, process.env.SESSION_SECRET);
  res.setHeader("Set-Cookie", COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + Math.floor(MAX_AGE_MS / 1000));
}

function clearCookie(res) {
  res.setHeader("Set-Cookie", COOKIE_NAME + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
}

// Returns the session payload if valid, otherwise writes a 401 and returns null.
function requireSession(req, res) {
  var cookies = parseCookies(req);
  var payload = verify(cookies[COOKIE_NAME], process.env.SESSION_SECRET);
  if (!payload) {
    res.status(401).json({ error: "Not authenticated." });
    return null;
  }
  return payload;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  var chunks = [];
  for await (var chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

module.exports = { issueCookie, clearCookie, requireSession, readJsonBody };
