// Vercel Cron target - runs once a day (see vercel.json), not something a
// browser ever calls. Finds contracts crossing the admin-configured "alert
// lead time" before their expiry date and emails the configured recipient(s)
// once per contract per expiry date (tracked via expiryAlertSentFor, so a
// renewal with a new expiryDate can trigger a fresh alert later).
const { Redis } = require("@upstash/redis");

var redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
var STATE_KEY = "docket:state";
var DEFAULT_LEAD_MONTHS = 4;
var CLOSED_STATUSES = ["Expired", "Terminated", "Archived", "Renewed"];

function addMonthsISO(iso, months) {
  var p = iso.split("-").map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function buildEmailHtml(contracts, leadMonths) {
  var rows = contracts.map(function (c) {
    var days = Math.round((new Date(c.expiryDate + "T00:00:00Z") - new Date(todayISO() + "T00:00:00Z")) / 86400000);
    var daysLabel = days < 0 ? Math.abs(days) + " days overdue" : days + " days left";
    return "<tr>" +
      "<td style=\"padding:6px 10px;border-bottom:1px solid #e5e5e5;\">" + escapeHtml(c.title || "(untitled)") + "<br><span style=\"color:#888;font-size:12px;\">" + escapeHtml(c.id) + "</span></td>" +
      "<td style=\"padding:6px 10px;border-bottom:1px solid #e5e5e5;\">" + escapeHtml(c.counterparty || "—") + "</td>" +
      "<td style=\"padding:6px 10px;border-bottom:1px solid #e5e5e5;\">" + escapeHtml(c.expiryDate) + "</td>" +
      "<td style=\"padding:6px 10px;border-bottom:1px solid #e5e5e5;\">" + escapeHtml(daysLabel) + "</td>" +
      "</tr>";
  }).join("");
  return "<div style=\"font-family:sans-serif;color:#222;\">" +
    "<h2 style=\"margin:0 0 8px;\">Docket: " + contracts.length + " contract(s) approaching expiry</h2>" +
    "<p style=\"color:#555;margin:0 0 16px;\">These contracts are now within " + leadMonths + " month(s) of their expiry date.</p>" +
    "<table style=\"border-collapse:collapse;width:100%;max-width:640px;\">" +
    "<thead><tr style=\"text-align:left;\">" +
    "<th style=\"padding:6px 10px;border-bottom:2px solid #333;\">Contract</th>" +
    "<th style=\"padding:6px 10px;border-bottom:2px solid #333;\">Counterparty</th>" +
    "<th style=\"padding:6px 10px;border-bottom:2px solid #333;\">Expiry</th>" +
    "<th style=\"padding:6px 10px;border-bottom:2px solid #333;\">Status</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    "<p style=\"color:#888;font-size:12px;margin-top:20px;\">Sent automatically by Docket. Change the recipient or lead time in Admin Settings.</p>" +
    "</div>";
}

function sendEmail(to, html, count) {
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      from: "Docket <onboarding@resend.dev>",
      to: to,
      subject: "Docket: " + count + " contract(s) expiring soon",
      html: html
    })
  }).then(function (res) {
    if (!res.ok) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        throw new Error((data && data.message) || (res.status + " " + res.statusText));
      });
    }
    return res.json();
  });
}

module.exports = async (req, res) => {
  // Vercel automatically sends this bearer token on cron-triggered requests
  // when CRON_SECRET is set - anyone else calling this URL gets rejected.
  var auth = req.headers && req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== "Bearer " + process.env.CRON_SECRET) {
    res.status(401).json({ error: "Not authorized." });
    return;
  }

  try {
    var state = await redis.get(STATE_KEY);
    if (!state || !Array.isArray(state.contracts)) {
      res.status(200).json({ sent: 0, reason: "No state yet." });
      return;
    }
    // Same defaults the client seeds on boot (see finishBoot() in app.js) -
    // duplicated here so this endpoint doesn't depend on someone having
    // already opened the app in a browser first. Persisted back so Admin
    // Settings shows the same values next time it's opened.
    var settingsChanged = false;
    if (!state.settings || typeof state.settings !== "object") { state.settings = {}; settingsChanged = true; }
    if (state.settings.notificationEmail == null) { state.settings.notificationEmail = "kenneth_soo@kingston.edu.sg"; settingsChanged = true; }
    if (state.settings.notificationLeadMonths == null) { state.settings.notificationLeadMonths = DEFAULT_LEAD_MONTHS; settingsChanged = true; }
    if (settingsChanged) await redis.set(STATE_KEY, state);

    var settings = state.settings;
    // ?test=<email> overrides the recipient for a one-off manual check (still
    // gated by the same CRON_SECRET bearer check above, not publicly
    // reachable) - real recipient/lead-time settings are untouched, and
    // expiryAlertSentFor is deliberately NOT updated on a test run, so it
    // doesn't consume the "already notified" flag before the real recipient
    // ever sees it.
    var isTest = !!(req.query && req.query.test);
    var email = isTest ? req.query.test : settings.notificationEmail;
    if (!email) {
      res.status(200).json({ sent: 0, reason: "No notification email configured." });
      return;
    }
    var leadMonths = Number(settings.notificationLeadMonths) || DEFAULT_LEAD_MONTHS;
    var threshold = addMonthsISO(todayISO(), leadMonths);

    var qualifying = state.contracts.filter(function (c) {
      return c.expiryDate
        && CLOSED_STATUSES.indexOf(c.status) === -1
        && c.expiryDate <= threshold
        && (isTest || c.expiryAlertSentFor !== c.expiryDate);
    });

    if (!qualifying.length) {
      res.status(200).json({ sent: 0 });
      return;
    }

    var recipients = String(email).split(",").map(function (e) { return e.trim(); }).filter(Boolean);
    var html = buildEmailHtml(qualifying, leadMonths);
    await sendEmail(recipients, html, qualifying.length);

    if (isTest) {
      res.status(200).json({ sent: qualifying.length, test: true, to: recipients });
      return;
    }

    var qualifyingIds = {};
    qualifying.forEach(function (c) { qualifyingIds[c.id] = c.expiryDate; });
    state.contracts.forEach(function (c) {
      if (qualifyingIds.hasOwnProperty(c.id)) c.expiryAlertSentFor = qualifyingIds[c.id];
    });
    await redis.set(STATE_KEY, state);

    res.status(200).json({ sent: qualifying.length });
  } catch (e) {
    res.status(500).json({ error: "Could not check expiring contracts: " + (e && e.message ? e.message : String(e)) });
  }
};
