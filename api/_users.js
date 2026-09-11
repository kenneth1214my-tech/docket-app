// Shared helper for per-user accounts. Not a route - "_" prefix excludes it
// from Vercel's file-routing. Deliberately a SEPARATE Redis key from
// docket:state (which holds contracts/entities/settings) so password hashes
// never end up inside an exported/imported JSON backup.
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
var USERS_KEY = "docket:users";

async function getUsers() {
  var users = await redis.get(USERS_KEY);
  return Array.isArray(users) ? users : [];
}

async function saveUsers(users) {
  await redis.set(USERS_KEY, users);
}

function findUserByEmail(users, email) {
  var e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  return users.find(function (u) { return u.email && u.email.toLowerCase() === e; }) || null;
}

function findUserById(users, id) {
  return users.find(function (u) { return u.id === id; }) || null;
}

function nextUserId() {
  return "usr_" + crypto.randomBytes(9).toString("base64url");
}

// What's safe to send to the client - never the password hash.
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active !== false, createdAt: u.createdAt };
}

module.exports = { getUsers, saveUsers, findUserByEmail, findUserById, nextUserId, publicUser };
