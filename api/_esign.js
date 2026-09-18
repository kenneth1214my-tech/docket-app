// Shared helpers for e-signature records. Not a route - "_" prefix excludes
// it from Vercel's file-routing.
//
// Each signing request is its own Redis key (docket:esign:<id>), separate
// from the single big docket:state blob - these grow and get read/written
// independently of the contract register, and a receiver fetching their one
// record should never pull (or risk corrupting) the whole team's data.
// docket:esign:index is a small array of summaries for the "my documents"
// list, updated alongside each record so listing never has to scan keys.
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
var INDEX_KEY = "docket:esign:index";

function recordKey(id) {
  return "docket:esign:" + id;
}

// Long and random enough to serve as the receiver's entire access control -
// the same "unguessable link is the credential" pattern already used for
// this app's upload access code. Not tied to any login.
function newId() {
  return crypto.randomBytes(18).toString("base64url");
}

async function getRecord(id) {
  if (!id || typeof id !== "string") return null;
  return await redis.get(recordKey(id));
}

async function saveRecord(record) {
  await redis.set(recordKey(record.id), record);
}

async function getIndex() {
  var idx = await redis.get(INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

async function upsertIndexEntry(entry) {
  var idx = await getIndex();
  var i = idx.findIndex(function (e) { return e.id === entry.id; });
  if (i === -1) idx.unshift(entry);
  else idx[i] = Object.assign({}, idx[i], entry);
  await redis.set(INDEX_KEY, idx);
}

async function removeIndexEntry(id) {
  var idx = await getIndex();
  var next = idx.filter(function (e) { return e.id !== id; });
  await redis.set(INDEX_KEY, next);
}

module.exports = { newId, getRecord, saveRecord, getIndex, upsertIndexEntry, removeIndexEntry };
