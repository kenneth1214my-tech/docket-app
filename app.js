(function () {
  "use strict";

  var STORAGE_KEY = "docket_state_v1";
  var LANG_KEY = "docket_lang";
  var I18N = window.DocketI18n;

  function t(key) { return I18N.t(UI.lang, key); }
  function tx(value) { return I18N.taxLabel(UI.lang, value); }

  var DEFAULT_ENTITIES = ["Entity A", "Entity B", "Entity C", "Other Group Entity"];

  var TAXONOMY = {
    contractTypes: ["NDA / Confidentiality Agreement", "Master Service Agreement (MSA)", "Statement of Work (SOW)", "Vendor / Supplier Agreement", "Customer / Sales Agreement", "Freight Forwarding Agreement", "Customs Brokerage Agreement", "Warehouse / 3PL Agreement", "Distribution / Agency Agreement", "Lease Agreement (Property/Equipment)", "Employment Contract", "Consulting / Independent Contractor", "Insurance Policy", "Loan / Financing Agreement", "Joint Venture Agreement", "Licensing Agreement", "Franchise Agreement", "Government Permit / Regulatory Licence", "Non-Compete / Non-Solicit", "IT / SaaS Subscription Agreement", "Other"],
    statuses: ["Draft", "Under Negotiation", "Pending Signature", "Active", "Expiring Soon", "Expired", "Terminated", "Renewed", "Archived"],
    riskTiers: ["Critical", "High", "Medium", "Low"],
    departments: ["Executive / Management", "Finance", "Legal / Compliance", "Operations / Logistics", "Sales & Business Development", "Human Resources", "IT", "Procurement"],
    confidentiality: ["Public", "Internal", "Confidential", "Highly Confidential / Restricted"],
    counterpartyTypes: ["Vendor / Supplier", "Customer", "Employee", "Agent / Distributor", "Landlord", "Government / Regulator", "Financial Institution", "Joint Venture Partner", "Other"],
    currencies: ["SGD", "USD", "MYR", "CNY", "EUR", "HKD", "GBP", "IDR", "THB", "VND"]
  };

  var EMPTY_STATE = { contracts: [], entities: DEFAULT_ENTITIES.slice() };

  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return JSON.parse(JSON.stringify(EMPTY_STATE));
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.contracts)) return JSON.parse(JSON.stringify(EMPTY_STATE));
      if (!Array.isArray(parsed.entities) || !parsed.entities.length) parsed.entities = DEFAULT_ENTITIES.slice();
      return parsed;
    } catch (e) {
      console.warn("Docket: could not read saved data, starting fresh.", e);
      return JSON.parse(JSON.stringify(EMPTY_STATE));
    }
  }

  function saveState(state) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error("Docket: could not save data.", e);
      return false;
    }
  }

  function loadLang() {
    try {
      var saved = window.localStorage.getItem(LANG_KEY);
      if (saved && I18N.LANGS.some(function (l) { return l.code === saved; })) return saved;
    } catch (e) { /* ignore */ }
    var nav = (navigator.language || "en").slice(0, 2).toLowerCase();
    return I18N.LANGS.some(function (l) { return l.code === nav; }) ? nav : "en";
  }

  function saveLang(lang) {
    try { window.localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
  }

  var STATE = loadState();
  var UI = {
    view: sessionStorage.getItem("docket_ui_view") || "dashboard",
    lang: loadLang(),
    search: "",
    statusFilter: "all",
    riskFilter: "all",
    modal: null
  };

  function slugClass(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return "—";
    var locale = { en: "en-SG", zh: "zh-CN", ms: "ms-MY", ko: "ko-KR", ja: "ja-JP", id: "id-ID", tl: "fil-PH" }[UI.lang] || "en-SG";
    return d.toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" });
  }
  function fmtMoney(v, ccy) {
    if (v == null || v === "" || isNaN(v)) return "—";
    var n = Number(v);
    return (ccy || "") + " " + n.toLocaleString("en-SG", { maximumFractionDigits: 0 });
  }
  function todayMidnight() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }

  function computeAlert(c) {
    if (!c.expiryDate) return { days: null, key: "na", label: "N/A" };
    if (["Expired", "Terminated", "Archived"].indexOf(c.status) !== -1) return { days: null, key: "na", label: "N/A" };
    var exp = new Date(c.expiryDate + "T00:00:00");
    if (isNaN(exp)) return { days: null, key: "na", label: "N/A" };
    var days = Math.round((exp - todayMidnight()) / 86400000);
    if (days < 0) return { days: days, key: "overdue", label: t("radar_overdue") + " · " + Math.abs(days) + "d" };
    if (days <= 30) return { days: days, key: "critical", label: t("radar_critical").split(" · ")[0] + " · " + days + "d" };
    if (days <= 60) return { days: days, key: "warning", label: t("radar_warning").split(" · ")[0] + " · " + days + "d" };
    if (days <= 90) return { days: days, key: "watch", label: t("radar_watch").split(" · ")[0] + " · " + days + "d" };
    return { days: days, key: "ok", label: t("radar_ok").split(" · ")[0] + " · " + days + "d" };
  }

  function nextContractId(contracts, year) {
    var y = year || new Date().getFullYear();
    var max = 0;
    contracts.forEach(function (c) {
      var m = /^CTR-(\d{4})-(\d{3})$/.exec(c.id || "");
      if (m && Number(m[1]) === y) max = Math.max(max, Number(m[2]));
    });
    return "CTR-" + y + "-" + String(max + 1).padStart(3, "0");
  }

  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  var SAMPLE_CONTRACTS = [
    { id: "CTR-2026-001", title: "Air Freight Forwarding Agreement", entity: "Entity A", counterparty: "Global Air Cargo (Singapore) Pte Ltd", counterpartyType: "Vendor / Supplier", department: "Operations / Logistics", contractType: "Freight Forwarding Agreement", riskTier: "Critical", confidentiality: "Confidential", status: "Active", startDate: addDays(-400), expiryDate: addDays(20), autoRenewal: "Yes", noticeDays: 60, value: 850000, currency: "SGD", paymentTerms: "Net 30", governingLaw: "Singapore", obligations: "Volume-based air freight rates; SLA 48hr pickup.", terminationClause: "Either party 60 days written notice.", liabilityNotes: "Liability capped at 1x annual fees.", tags: "freight, air, critical-vendor", notes: "Sample record — edit or delete freely." },
    { id: "CTR-2025-014", title: "Customs Brokerage Services Agreement", entity: "Entity B", counterparty: "Continental Freight Partners Sdn Bhd", counterpartyType: "Vendor / Supplier", department: "Operations / Logistics", contractType: "Customs Brokerage Agreement", riskTier: "High", confidentiality: "Internal", status: "Active", startDate: addDays(-200), expiryDate: addDays(45), autoRenewal: "Yes", noticeDays: 30, value: 120000, currency: "MYR", paymentTerms: "Net 45", governingLaw: "Malaysia", obligations: "Customs clearance and duty advance.", terminationClause: "30 days notice; auto-renews annually.", liabilityNotes: "Indemnity capped at MYR 500,000.", tags: "customs, malaysia", notes: "Sample record — edit or delete freely." },
    { id: "CTR-2025-022", title: "Cargo Insurance Policy - Annual", entity: "Entity B", counterparty: "Beacon Insurance (Singapore) Pte Ltd", counterpartyType: "Financial Institution", department: "Finance", contractType: "Insurance Policy", riskTier: "High", confidentiality: "Internal", status: "Expiring Soon", startDate: addDays(-350), expiryDate: addDays(15), autoRenewal: "Yes", noticeDays: 30, value: 45000, currency: "SGD", paymentTerms: "Annual, upfront", governingLaw: "Singapore", obligations: "All-risk cargo cover up to SGD 5,000,000.", terminationClause: "Auto-renews unless cancelled 30 days before expiry.", liabilityNotes: "Excess SGD 2,500 per claim.", tags: "insurance, cargo", notes: "Sample record — edit or delete freely." },
    { id: "CTR-2022-002", title: "Office Lease - HQ", entity: "Entity A", counterparty: "Skyline Property Management Pte Ltd", counterpartyType: "Landlord", department: "Finance", contractType: "Lease Agreement (Property/Equipment)", riskTier: "Low", confidentiality: "Internal", status: "Expired", startDate: addDays(-1400), expiryDate: addDays(-30), autoRenewal: "No", noticeDays: 90, value: 180000, currency: "SGD", paymentTerms: "Monthly", governingLaw: "Singapore", obligations: "Office unit, HQ operations.", terminationClause: "Fixed term; holding over month-to-month.", liabilityNotes: "Standard commercial lease terms.", tags: "lease, hq, overdue", notes: "Sample record — shows an overdue contract." }
  ];

  function persist(mutateFn, successKey) {
    var next = JSON.parse(JSON.stringify(STATE));
    mutateFn(next);
    STATE = next;
    UI.modal = null;
    sessionStorage.setItem("docket_ui_view", UI.view);
    var ok = saveState(STATE);
    render();
    if (successKey) showToast(ok ? t(successKey) : t("toast_session_only"));
  }

  function mutateEntitiesState(mutateFn) {
    var next = JSON.parse(JSON.stringify(STATE));
    mutateFn(next);
    STATE = next;
    saveState(STATE);
    render();
  }

  var toastTimer = null;
  function showToast(msg) {
    var wrap = document.getElementById("toast-wrap");
    if (!wrap) return;
    wrap.innerHTML = '<div class="toast">' + esc(msg) + "</div>";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { wrap.innerHTML = ""; }, 3200);
  }

  // ---------- import / export ----------
  function exportData() {
    var blob = new Blob([JSON.stringify(STATE, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "docket-export-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.contracts)) throw new Error("File does not look like a Docket export.");
        persist(function (next) { next.contracts = parsed.contracts; }, "toast_imported");
      } catch (e) {
        showToast(t("toast_import_error") + e.message);
      }
    };
    reader.onerror = function () { showToast(t("toast_read_error")); };
    reader.readAsText(file);
  }

  // ---------- rendering ----------
  function render() {
    document.documentElement.lang = UI.lang;
    var root = document.getElementById("app-root");
    root.innerHTML = renderShell();
    bindEvents();
  }

  function renderShell() {
    return (
      renderTopStrip() +
      '<div class="shell">' +
        renderSidebar() +
        '<main class="main">' + (UI.view === "dashboard" ? renderDashboard() : renderRegister()) + "</main>" +
      "</div>" +
      (UI.modal ? renderModal() : "") +
      '<div id="toast-wrap" class="toast-wrap" role="status" aria-live="polite"></div>' +
      '<input type="file" id="import-input" accept="application/json" class="visually-hidden">'
    );
  }

  function renderTopStrip() {
    return (
      '<div class="top-strip">' +
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c2 2 3 4.6 3 7.2s-1 5.2-3 7.2c-2-2-3-4.6-3-7.2s1-5.2 3-7.2z"/></svg>' +
        '<select id="lang-select" class="chip-select" aria-label="' + esc(t("language")) + '">' +
          I18N.LANGS.map(function (l) { return '<option value="' + l.code + '"' + (l.code === UI.lang ? " selected" : "") + ">" + esc(l.name) + "</option>"; }).join("") +
        "</select>" +
      "</div>"
    );
  }

  function navIcon(name) {
    if (name === "dashboard") return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.3"/><rect x="11" y="2.5" width="6.5" height="4" rx="1.3"/><rect x="11" y="8.5" width="6.5" height="9" rx="1.3"/><rect x="2.5" y="11" width="6.5" height="6.5" rx="1.3"/></svg>';
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.5h7l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M12 2.5v3h3"/><path d="M6.5 10h7M6.5 13h7M6.5 7h3"/></svg>';
  }

  function logoMark() {
    return '<svg class="logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
      '<rect x="1" y="1" width="30" height="30" rx="9" fill="var(--primary)"/>' +
      '<path d="M11.5 9.5h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z" stroke="var(--primary-ink)" stroke-width="1.6"/>' +
      '<path d="M13 15.2l2.1 2.1 3.9-4.2" stroke="var(--primary-ink)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>";
  }

  var KPI_ICONS = {
    total: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 2.3l7 3.5-7 3.5-7-3.5 7-3.5z" stroke-linejoin="round"/><path d="M3 9.3l7 3.5 7-3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 13.3l7 3.5 7-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    active: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.2"/><path d="M6.8 10.2l2.1 2.1 4.3-4.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.2"/><path d="M10 6.2v4l2.8 1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 3.3l7.3 12.6a0.9 0.9 0 0 1-0.8 1.3H3.5a0.9 0.9 0 0 1-0.8-1.3L10 3.3z" stroke-linejoin="round"/><path d="M10 8.3v3.4" stroke-linecap="round"/><circle cx="10" cy="14.1" r="0.95" fill="currentColor" stroke="none"/></svg>',
    shield: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 2.6l5.8 2.1v4.6c0 3.9-2.5 6.6-5.8 7.8-3.3-1.2-5.8-3.9-5.8-7.8V4.7L10 2.6z" stroke-linejoin="round"/><path d="M10 7.2v3.3" stroke-linecap="round"/><circle cx="10" cy="13" r="0.95" fill="currentColor" stroke="none"/></svg>'
  };

  function renderSidebar() {
    return (
      '<div class="sidebar">' +
        '<div class="brand">' + logoMark() + '<span class="wordmark"><span class="mark">Docket</span><span class="tag">' + esc(t("brand_tag")) + "</span></span></div>" +
        '<nav class="nav">' +
          '<button class="nav-item' + (UI.view === "dashboard" ? " active" : "") + '" data-nav="dashboard">' + navIcon("dashboard") + esc(t("nav_dashboard")) + "</button>" +
          '<button class="nav-item' + (UI.view === "register" ? " active" : "") + '" data-nav="register">' + navIcon("register") + esc(t("nav_contracts")) + "</button>" +
        "</nav>" +
        '<div class="sidebar-foot">' +
          "<div><strong>" + esc(t("sidebar_data_title")) + "</strong><br>" + esc(t("sidebar_data_body")) + "</div>" +
          '<div class="sidebar-actions">' +
            '<button class="link-btn" data-action="manage-entities">' + esc(t("manage_entities")) + "</button>" +
            '<button class="link-btn" data-action="export">' + esc(t("export_data")) + "</button>" +
            '<button class="link-btn" data-action="import">' + esc(t("import_data")) + "</button>" +
            (STATE.contracts.length === 0 ? '<button class="link-btn" data-action="load-sample">' + esc(t("load_sample")) + "</button>" : '<button class="link-btn" data-action="clear-all">' + esc(t("clear_all")) + "</button>") +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  function kpi(label, value, iconKey, tone) {
    return '<div class="kpi' + (tone ? " tone-" + tone : "") + '"><div class="label-row"><div class="label">' + esc(label) + "</div>" +
      (iconKey ? '<span class="kpi-icon">' + KPI_ICONS[iconKey] + "</span>" : "") +
      '</div><div class="value">' + value + "</div></div>";
  }

  function renderDashboard() {
    var cs = STATE.contracts;
    if (cs.length === 0) return renderEmptyDashboard();

    var alerts = cs.map(computeAlert);
    var total = cs.length;
    var active = cs.filter(function (c) { return c.status === "Active"; }).length;
    var expiringSoon = cs.filter(function (c) { return c.status === "Expiring Soon"; }).length;
    var overdueOrExpired = cs.filter(function (c, i) { return c.status === "Expired" || alerts[i].key === "overdue"; }).length;
    var criticalRisk = cs.filter(function (c) { return c.riskTier === "Critical"; }).length;

    var radarCounts = { overdue: 0, critical: 0, warning: 0, watch: 0, ok: 0 };
    alerts.forEach(function (a) { if (radarCounts.hasOwnProperty(a.key)) radarCounts[a.key]++; });

    var withDays = cs.map(function (c, i) { return { c: c, a: alerts[i] }; })
      .filter(function (x) { return x.a.days !== null; })
      .sort(function (x, y) { return x.a.days - y.a.days; })
      .slice(0, 8);

    var byCurrency = {};
    cs.forEach(function (c) {
      if (c.status !== "Active" || !c.value) return;
      byCurrency[c.currency || "—"] = (byCurrency[c.currency || "—"] || 0) + Number(c.value || 0);
    });

    return (
      '<div class="topbar"><div><h1>' + esc(t("dash_title")) + "</h1><div class=\"sub\">" + esc(t("dash_sub")) + "</div></div></div>" +
      '<div class="kpi-grid">' +
        kpi(t("kpi_total"), total, "total") +
        kpi(t("kpi_active"), active, "active", "success") +
        kpi(t("kpi_expiring"), expiringSoon, "clock", expiringSoon > 0 ? "warning" : null) +
        kpi(t("kpi_overdue"), overdueOrExpired, "alert", overdueOrExpired > 0 ? "danger" : null) +
        kpi(t("kpi_critical"), criticalRisk, "shield", criticalRisk > 0 ? "danger" : null) +
      "</div>" +
      renderPortfolioPanel(cs) +
      '<div class="panel">' +
        '<div class="panel-head"><h2>' + esc(t("radar_title")) + '</h2><span class="hint">' + esc(t("radar_hint")) + "</span></div>" +
        '<div class="radar">' +
          radarCell("overdue", t("radar_overdue"), radarCounts.overdue) +
          radarCell("critical", t("radar_critical"), radarCounts.critical) +
          radarCell("warning", t("radar_warning"), radarCounts.warning) +
          radarCell("watch", t("radar_watch"), radarCounts.watch) +
          radarCell("ok", t("radar_ok"), radarCounts.ok) +
        "</div>" +
      "</div>" +
      '<div class="panel">' +
        '<div class="panel-head"><h2>' + esc(t("soonest_title")) + '</h2><span class="hint">' + esc(t("soonest_hint_top")) + " " + withDays.length + "</span></div>" +
        (withDays.length ? '<ul class="top-list">' + withDays.map(function (x, i) {
          return '<li><span class="rank">#' + (i + 1) + '</span>' +
            '<div class="info"><div class="t">' + esc(x.c.title) + '</div><div class="s">' + esc(x.c.counterparty) + " · " + esc(tx(x.c.entity)) + "</div></div>" +
            '<span class="pill alert-' + x.a.key + '">' + esc(x.a.label) + "</span></li>";
        }).join("") + "</ul>" : '<div class="empty-state" style="padding:24px"><p>' + esc(t("soonest_empty")) + "</p></div>") +
      "</div>" +
      '<div class="panel">' +
        '<div class="panel-head"><h2>' + esc(t("value_title")) + "</h2></div>" +
        '<div class="panel-body table-wrap"><table><thead><tr><th>' + esc(t("col_currency")) + '</th><th class="num">' + esc(t("col_total_value")) + "</th></tr></thead><tbody>" +
        (Object.keys(byCurrency).length ? Object.keys(byCurrency).map(function (k) {
          return "<tr><td>" + esc(k) + '</td><td class="num">' + fmtMoney(byCurrency[k], k) + "</td></tr>";
        }).join("") : '<tr><td colspan="2" style="color:var(--ink-faint)">' + esc(t("value_empty")) + "</td></tr>") +
        "</tbody></table></div>" +
      "</div>"
    );
  }

  function emptyIllustration() {
    return '<svg class="empty-illustration" viewBox="0 0 96 96" fill="none" aria-hidden="true">' +
      '<path d="M14 40V29a6 6 0 0 1 6-6h15l8 9h29a6 6 0 0 1 6 6v2" stroke="var(--primary)" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<rect x="14" y="40" width="68" height="35" rx="6" fill="var(--primary-tint)" stroke="var(--primary)" stroke-width="2.2"/>' +
      '<path d="M28 55h30M28 63h20" stroke="var(--primary)" stroke-width="2.2" stroke-linecap="round" opacity="0.55"/>' +
      '<circle cx="71" cy="33" r="13" fill="var(--primary)"/>' +
      '<path d="M71 27.5v11M65.5 33h11" stroke="var(--primary-ink)" stroke-width="2.6" stroke-linecap="round"/>' +
      "</svg>";
  }

  function renderEmptyDashboard() {
    return (
      '<div class="topbar"><div><h1>' + esc(t("dash_title")) + "</h1><div class=\"sub\">" + esc(t("dash_sub")) + "</div></div></div>" +
      '<div class="panel"><div class="empty-state">' +
        emptyIllustration() +
        "<h3>" + esc(t("empty_dash_title")) + "</h3>" +
        "<p>" + esc(t("empty_dash_body")) + "</p>" +
        '<div class="empty-actions">' +
          '<button class="btn btn-primary" data-action="new-contract-empty">' + esc(t("add_first_contract")) + "</button>" +
          '<button class="btn btn-ghost" data-action="load-sample">' + esc(t("load_sample")) + "</button>" +
        "</div>" +
      "</div></div>"
    );
  }

  function radarCell(key, label, n) {
    return '<div class="radar-cell ' + key + '"><div class="n">' + n + '</div><div class="l">' + esc(label) + "</div></div>";
  }

  function statusTone(status) {
    if (status === "Active" || status === "Renewed") return "active";
    if (status === "Expiring Soon") return "medium";
    if (status === "Terminated") return "critical";
    if (status === "Under Negotiation" || status === "Pending Signature") return "primary";
    return "neutral"; // Draft, Expired, Archived
  }
  function riskTone(risk) {
    return { Critical: "critical", High: "high", Medium: "medium", Low: "low" }[risk] || "neutral";
  }

  function barRow(label, value, max, tone) {
    var pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0;
    return '<div class="bar-row"><div class="bar-label" title="' + esc(label) + '">' + esc(label) + '</div>' +
      '<div class="bar-track"><div class="bar-fill tone-' + tone + '" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-value">' + value + "</div></div>";
  }

  function renderPortfolioPanel(cs) {
    var statusCounts = {};
    TAXONOMY.statuses.forEach(function (s) { statusCounts[s] = 0; });
    cs.forEach(function (c) { if (statusCounts.hasOwnProperty(c.status)) statusCounts[c.status]++; });
    var statusesUsed = TAXONOMY.statuses.filter(function (s) { return statusCounts[s] > 0; });
    var maxStatus = Math.max.apply(null, statusesUsed.map(function (s) { return statusCounts[s]; }).concat([1]));

    var riskCounts = {};
    TAXONOMY.riskTiers.forEach(function (r) { riskCounts[r] = 0; });
    cs.forEach(function (c) { if (riskCounts.hasOwnProperty(c.riskTier)) riskCounts[c.riskTier]++; });
    var maxRisk = Math.max.apply(null, TAXONOMY.riskTiers.map(function (r) { return riskCounts[r]; }).concat([1]));

    return (
      '<div class="panel">' +
        '<div class="panel-head"><h2>' + esc(t("portfolio_title")) + "</h2></div>" +
        '<div class="bar-list bar-columns">' +
          "<div>" +
            '<div class="bar-col-title">' + esc(t("col_status")) + "</div>" +
            statusesUsed.map(function (s) { return barRow(tx(s), statusCounts[s], maxStatus, statusTone(s)); }).join("") +
          "</div>" +
          "<div>" +
            '<div class="bar-col-title">' + esc(t("col_risk")) + "</div>" +
            TAXONOMY.riskTiers.map(function (r) { return barRow(tx(r), riskCounts[r], maxRisk, riskTone(r)); }).join("") +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  function renderRegister() {
    var cs = STATE.contracts.slice();
    var q = UI.search.trim().toLowerCase();
    if (q) {
      cs = cs.filter(function (c) {
        return [c.id, c.title, c.entity, c.counterparty, c.tags].join(" ").toLowerCase().indexOf(q) !== -1;
      });
    }
    if (UI.statusFilter !== "all") cs = cs.filter(function (c) { return c.status === UI.statusFilter; });
    if (UI.riskFilter !== "all") cs = cs.filter(function (c) { return c.riskTier === UI.riskFilter; });

    var rows = cs.map(function (c) { return { c: c, a: computeAlert(c) }; }).sort(function (x, y) {
      var dx = x.a.days === null ? Infinity : x.a.days;
      var dy = y.a.days === null ? Infinity : y.a.days;
      return dx - dy;
    });

    var isEmptyRegister = STATE.contracts.length === 0;

    return (
      '<div class="topbar"><div><h1>' + esc(t("nav_contracts")) + "</h1><div class=\"sub\">" + STATE.contracts.length + " " + esc(t("reg_total")) + " · " + rows.length + " " + esc(t("reg_shown")) + "</div></div>" +
        '<div class="topbar-actions"><button class="btn btn-primary" data-action="new-contract"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4v12M4 10h12"/></svg>' + esc(t("new_contract")) + "</button></div>" +
      "</div>" +
      '<div class="panel">' +
        (isEmptyRegister ? "" : '<div class="filters">' +
          '<div class="search-input"><input type="text" id="search-box" placeholder="' + esc(t("search_placeholder")) + '" value="' + esc(UI.search) + '"></div>' +
          selectChip("status-filter", ["all"].concat(TAXONOMY.statuses), UI.statusFilter, t("filter_all_statuses")) +
          selectChip("risk-filter", ["all"].concat(TAXONOMY.riskTiers), UI.riskFilter, t("filter_all_risks")) +
        "</div>") +
        '<div class="table-wrap">' +
        (rows.length ? '<table><thead><tr><th>' + esc(t("col_contract")) + '</th><th>' + esc(t("col_entity")) + '</th><th>' + esc(t("col_counterparty")) + '</th><th>' + esc(t("col_risk")) + '</th><th>' + esc(t("col_status")) + '</th><th>' + esc(t("col_expiry")) + '</th><th>' + esc(t("col_alert")) + '</th><th class="num">' + esc(t("col_value")) + "</th><th></th></tr></thead><tbody>" +
          rows.map(function (x) {
            var c = x.c, a = x.a;
            return "<tr>" +
              '<td><div class="cell-title">' + esc(c.title) + '</div><div class="cell-sub mono">' + esc(c.id) + "</div></td>" +
              "<td>" + esc(tx(c.entity)) + "</td>" +
              "<td>" + esc(c.counterparty) + "</td>" +
              '<td><span class="pill risk-' + slugClass(c.riskTier) + '">' + esc(tx(c.riskTier) || "—") + "</span></td>" +
              '<td><span class="pill status-' + slugClass(c.status) + '">' + esc(tx(c.status) || "—") + "</span></td>" +
              '<td class="mono">' + fmtDate(c.expiryDate) + "</td>" +
              '<td><span class="pill alert-' + a.key + '">' + esc(a.label) + "</span></td>" +
              '<td class="num">' + fmtMoney(c.value, c.currency) + "</td>" +
              '<td><div class="row-actions">' +
                '<button class="icon-btn" data-action="edit" data-id="' + esc(c.id) + '" title="' + esc(t("action_edit")) + '"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13.5 3.5l3 3L6 17l-4 1 1-4z"/></svg></button>' +
                '<button class="icon-btn" data-action="delete" data-id="' + esc(c.id) + '" title="' + esc(t("action_delete")) + '"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h12M8 6V4h4v2m-7 0 1 11h8l1-11"/></svg></button>' +
              "</div></td>" +
            "</tr>";
          }).join("") + "</tbody></table>" :
          (isEmptyRegister ?
            '<div class="empty-state">' + emptyIllustration() + "<h3>" + esc(t("empty_reg_title")) + "</h3><p>" + esc(t("empty_reg_body")) + '</p><div class="empty-actions"><button class="btn btn-primary" data-action="new-contract-empty">' + esc(t("add_first_contract")) + '</button><button class="btn btn-ghost" data-action="load-sample">' + esc(t("load_sample")) + "</button></div></div>" :
            '<div class="empty-state"><h3>' + esc(t("empty_reg_match_title")) + "</h3><p>" + esc(t("empty_reg_match_body")) + "</p></div>")) +
        "</div>" +
      "</div>"
    );
  }

  function selectChip(id, options, current, allLabel) {
    return '<select class="chip-select" id="' + id + '">' + options.map(function (o) {
      var label = o === "all" ? allLabel : tx(o);
      return '<option value="' + esc(o) + '"' + (o === current ? " selected" : "") + ">" + esc(label) + "</option>";
    }).join("") + "</select>";
  }

  function fieldSelect(name, label, options, value, required) {
    return '<div class="field"><label>' + esc(label) + (required ? ' <span class="req">*</span>' : "") + '</label><select name="' + name + '">' +
      '<option value="">—</option>' +
      options.map(function (o) { return '<option value="' + esc(o) + '"' + (o === value ? " selected" : "") + ">" + esc(tx(o)) + "</option>"; }).join("") +
      "</select></div>";
  }
  function fieldSelectEntity(value) {
    return '<div class="field"><div class="field-label-row"><label>' + esc(t("f_entity")) + ' <span class="req">*</span></label>' +
      '<button type="button" class="link-btn" data-action="manage-entities">' + esc(t("manage_entities")) + "</button></div>" +
      '<select name="entity"><option value="">—</option>' +
      STATE.entities.map(function (o) { return '<option value="' + esc(o) + '"' + (o === value ? " selected" : "") + ">" + esc(tx(o)) + "</option>"; }).join("") +
      "</select></div>";
  }
  function fieldInput(name, label, value, type, required, full) {
    return '<div class="field' + (full ? " full" : "") + '"><label>' + esc(label) + (required ? ' <span class="req">*</span>' : "") + '</label><input name="' + name + '" type="' + (type || "text") + '" value="' + esc(value == null ? "" : value) + '"></div>';
  }
  function fieldTextarea(name, label, value) {
    return '<div class="field full"><label>' + esc(label) + '</label><textarea name="' + name + '" rows="2">' + esc(value) + "</textarea></div>";
  }

  function renderModal() {
    if (UI.modal.mode === "delete") return renderDeleteModal();
    if (UI.modal.mode === "clear-all") return renderClearAllModal();
    if (UI.modal.mode === "manage-entities") return renderEntitiesModal();
    return renderFormModal();
  }

  function renderEntitiesModal() {
    var usage = {};
    STATE.contracts.forEach(function (c) { if (c.entity) usage[c.entity] = (usage[c.entity] || 0) + 1; });
    var rows = STATE.entities.map(function (name, i) {
      var count = usage[name] || 0;
      return '<div class="entity-row">' +
        '<input type="text" data-action="entity-rename" data-index="' + i + '" value="' + esc(name) + '">' +
        (count > 0 ? '<span class="entity-usage">' + count + "</span>" : "") +
        '<button type="button" class="icon-btn" data-action="entity-delete" data-index="' + i + '" aria-label="' + esc(t("delete")) + '"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h12M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6m-7 0 .6 9.4a1 1 0 0 0 1 .9h5.8a1 1 0 0 0 1-.9L15 6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      "</div>";
    }).join("");
    return (
      '<div class="modal-overlay" data-overlay>' +
        '<div class="modal">' +
          '<div class="modal-head"><h2>' + esc(t("entities_modal_title")) + "</h2><button class=\"icon-btn\" data-action=\"close-modal\" aria-label=\"" + esc(t("cancel")) + "\"><svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><path d=\"M5 5l10 10M15 5L5 15\"/></svg></button></div>" +
          '<div class="modal-body">' +
            '<div class="entities-hint">' + esc(t("entities_hint")) + "</div>" +
            '<div class="entity-list">' + rows + "</div>" +
            '<div class="entity-add-row">' +
              '<input type="text" id="entity-add-input" placeholder="' + esc(t("entities_add_placeholder")) + '">' +
              '<button type="button" class="btn btn-ghost" data-action="entity-add">' + esc(t("entities_add_btn")) + "</button>" +
            "</div>" +
          "</div>" +
          '<div class="modal-foot"><button type="button" class="btn btn-primary" data-action="close-modal">' + esc(t("entities_done")) + "</button></div>" +
        "</div>" +
      "</div>"
    );
  }

  function renderDeleteModal() {
    var c = STATE.contracts.find(function (x) { return x.id === UI.modal.id; });
    if (!c) return "";
    return (
      '<div class="modal-overlay confirm-modal" data-overlay>' +
        '<div class="modal">' +
          '<div class="modal-head"><h2>' + esc(t("modal_delete_title")) + "</h2></div>" +
          '<div class="modal-body">' + esc(t("modal_delete_body_pre")) + " <strong>" + esc(c.title) + "</strong> (" + esc(c.id) + ") " + esc(t("modal_delete_body_post")) + "</div>" +
          '<div class="modal-foot"><button class="btn btn-ghost" data-action="close-modal">' + esc(t("cancel")) + '</button><button class="btn btn-danger" data-action="confirm-delete" data-id="' + esc(c.id) + '">' + esc(t("delete")) + "</button></div>" +
        "</div>" +
      "</div>"
    );
  }

  function renderClearAllModal() {
    return (
      '<div class="modal-overlay confirm-modal" data-overlay>' +
        '<div class="modal">' +
          '<div class="modal-head"><h2>' + esc(t("modal_clear_title")) + "</h2></div>" +
          '<div class="modal-body">' + esc(t("modal_clear_body_pre")) + " " + STATE.contracts.length + " " + esc(t("modal_clear_body_post")) + "</div>" +
          '<div class="modal-foot"><button class="btn btn-ghost" data-action="close-modal">' + esc(t("cancel")) + '</button><button class="btn btn-danger" data-action="confirm-clear-all">' + esc(t("clear_everything")) + "</button></div>" +
        "</div>" +
      "</div>"
    );
  }

  function renderUploadZone() {
    var m = UI.modal;
    if (m.reading) {
      var progressLine = m.ocrLabel ? '<div class="upload-hint">' + esc(t("upload_ocr_running")) + " — " + esc(m.ocrLabel) + (m.ocrPct != null ? " " + m.ocrPct + "%" : "") + "</div>" : "";
      return '<div class="upload-zone reading" id="upload-zone"><div class="upload-spinner"></div><div class="upload-title">' + esc(t("upload_reading")) + "</div>" + progressLine + "</div>";
    }
    if (m.sourceFileName) {
      var count = m.fieldsFound || 0;
      var body = count > 0
        ? esc(t("upload_prefilled_prefix")) + ' <strong>' + esc(m.sourceFileName) + "</strong> " + esc(t("upload_prefilled_suffix"))
        : esc(t("upload_prefilled_none"));
      return '<div class="upload-summary' + (count > 0 ? "" : " none") + '">' +
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.5h7l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M12 2.5v3h3"/></svg>' +
        '<div class="upload-summary-text">' + body + "</div>" +
        '<button type="button" class="link-btn" data-action="upload-reset">' + esc(t("upload_clear")) + "</button>" +
      "</div>";
    }
    return (
      '<div class="upload-zone" id="upload-zone">' +
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 13V4M10 4l-3 3M10 4l3 3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 13.5V15a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 15v-1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<div class="upload-title">' + esc(t("upload_zone_title")) + "</div>" +
        '<div class="upload-hint">' + esc(t("upload_zone_hint")) + "</div>" +
        '<input type="file" id="upload-input" accept=".pdf,.docx,.txt,.jpg,.jpeg,.png,.webp" class="visually-hidden">' +
      "</div>" +
      '<div class="upload-or-divider"><span>' + esc(t("upload_divider")) + "</span></div>"
    );
  }

  function renderFormModal() {
    var editing = UI.modal.mode === "edit";
    var c = editing ? STATE.contracts.find(function (x) { return x.id === UI.modal.id; }) : (UI.modal.draft || {});
    return (
      '<div class="modal-overlay" data-overlay>' +
        '<div class="modal">' +
          '<div class="modal-head"><h2>' + (editing ? esc(t("modal_edit_title")) : esc(t("modal_new_title"))) + "</h2><button class=\"icon-btn\" data-action=\"close-modal\" aria-label=\"" + esc(t("cancel")) + "\"><svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><path d=\"M5 5l10 10M15 5L5 15\"/></svg></button></div>" +
          '<form id="contract-form">' +
          '<div class="modal-body">' +
            (editing ? "" : renderUploadZone()) +
            '<div class="fieldset-title">' + esc(t("fs_basics")) + "</div>" +
            '<div class="field-grid">' +
              fieldInput("title", t("f_title"), c.title, "text", true, true) +
              fieldSelectEntity(c.entity) +
              fieldInput("counterparty", t("f_counterparty"), c.counterparty, "text", true) +
              fieldSelect("counterpartyType", t("f_counterpartyType"), TAXONOMY.counterpartyTypes, c.counterpartyType) +
              fieldSelect("department", t("f_department"), TAXONOMY.departments, c.department) +
              fieldSelect("contractType", t("f_contractType"), TAXONOMY.contractTypes, c.contractType, true) +
              fieldSelect("riskTier", t("f_riskTier"), TAXONOMY.riskTiers, c.riskTier) +
              fieldSelect("confidentiality", t("f_confidentiality"), TAXONOMY.confidentiality, c.confidentiality) +
              fieldSelect("status", t("f_status"), TAXONOMY.statuses, c.status || "Active", true) +
            "</div>" +
            '<div class="fieldset-title">' + esc(t("fs_dates")) + "</div>" +
            '<div class="field-grid">' +
              fieldInput("startDate", t("f_startDate"), c.startDate, "date") +
              fieldInput("expiryDate", t("f_expiryDate"), c.expiryDate, "date") +
              fieldSelect("autoRenewal", t("f_autoRenewal"), ["Yes", "No"], c.autoRenewal) +
              fieldInput("noticeDays", t("f_noticeDays"), c.noticeDays, "number") +
            "</div>" +
            '<div class="fieldset-title">' + esc(t("fs_financial")) + "</div>" +
            '<div class="field-grid">' +
              fieldInput("value", t("f_value"), c.value, "number") +
              fieldSelect("currency", t("f_currency"), TAXONOMY.currencies, c.currency) +
              fieldInput("paymentTerms", t("f_paymentTerms"), c.paymentTerms, "text", false, true) +
              fieldInput("governingLaw", t("f_governingLaw"), c.governingLaw, "text", false, true) +
            "</div>" +
            '<div class="fieldset-title">' + esc(t("fs_notes")) + "</div>" +
            fieldTextarea("obligations", t("f_obligations"), c.obligations) +
            fieldTextarea("terminationClause", t("f_terminationClause"), c.terminationClause) +
            fieldTextarea("liabilityNotes", t("f_liabilityNotes"), c.liabilityNotes) +
            fieldInput("tags", t("f_tags"), c.tags, "text", false, true) +
            fieldTextarea("notes", t("f_notes"), c.notes) +
          "</div>" +
          '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="close-modal">' + esc(t("cancel")) + '</button><button type="submit" class="btn btn-primary">' + (editing ? esc(t("save_changes")) : esc(t("add_contract_btn"))) + "</button></div>" +
          "</form>" +
        "</div>" +
      "</div>"
    );
  }

  // ---------- events ----------
  function openNewModal() { UI.modal = { mode: "add", draft: null, sourceFileName: null, reading: false, fieldsFound: 0 }; render(); }

  function handleUploadedFile(file) {
    if (!UI.modal || UI.modal.mode !== "add") return;
    var ext = file.name.split(".").pop().toLowerCase();
    if (["pdf", "docx", "txt", "jpg", "jpeg", "png", "webp", "bmp"].indexOf(ext) === -1) {
      showToast(t("upload_unsupported"));
      return;
    }
    UI.modal.reading = true;
    UI.modal.ocrLabel = null;
    UI.modal.ocrPct = null;
    render();

    var lastRenderAt = 0;
    function onProgress(label, fraction) {
      UI.modal.ocrLabel = label;
      UI.modal.ocrPct = Math.round((fraction || 0) * 100);
      var now = Date.now();
      if (now - lastRenderAt > 200) { lastRenderAt = now; render(); } // throttle - OCR fires progress very frequently
    }

    window.DocketExtract.extractText(file, onProgress).then(function (text) {
      var result = window.DocketExtract.guessFields(text);
      UI.modal.reading = false;
      UI.modal.draft = result.guess;
      UI.modal.sourceFileName = file.name;
      UI.modal.fieldsFound = result.fieldsFound;
      render();
    }).catch(function (err) {
      UI.modal.reading = false;
      render();
      var msg = (err && err.message === "UNSUPPORTED_TYPE") ? t("upload_unsupported") : t("upload_failed_prefix") + (err && err.message ? err.message : String(err));
      showToast(msg);
    });
  }

  function bindEvents() {
    document.querySelectorAll("[data-nav]").forEach(function (el) {
      el.addEventListener("click", function () {
        UI.view = el.getAttribute("data-nav");
        sessionStorage.setItem("docket_ui_view", UI.view);
        render();
      });
    });

    var langSelect = document.getElementById("lang-select");
    if (langSelect) langSelect.addEventListener("change", function () {
      UI.lang = langSelect.value;
      saveLang(UI.lang);
      render();
    });

    var newBtn = document.querySelector('[data-action="new-contract"]');
    if (newBtn) newBtn.addEventListener("click", openNewModal);
    var newBtnEmpty = document.querySelector('[data-action="new-contract-empty"]');
    if (newBtnEmpty) newBtnEmpty.addEventListener("click", openNewModal);

    var uploadZone = document.getElementById("upload-zone");
    var uploadInput = document.getElementById("upload-input");
    if (uploadZone && uploadInput) {
      uploadZone.addEventListener("click", function () { uploadInput.click(); });
      uploadInput.addEventListener("change", function () {
        if (uploadInput.files && uploadInput.files[0]) handleUploadedFile(uploadInput.files[0]);
      });
      ["dragenter", "dragover"].forEach(function (evt) {
        uploadZone.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation(); uploadZone.classList.add("drag-over"); });
      });
      ["dragleave", "dragend", "drop"].forEach(function (evt) {
        uploadZone.addEventListener(evt, function (e) { uploadZone.classList.remove("drag-over"); });
      });
      uploadZone.addEventListener("drop", function (e) {
        e.preventDefault(); e.stopPropagation();
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleUploadedFile(file);
      });
    }
    var uploadReset = document.querySelector('[data-action="upload-reset"]');
    if (uploadReset) uploadReset.addEventListener("click", function () {
      UI.modal.draft = null; UI.modal.sourceFileName = null; UI.modal.fieldsFound = 0;
      render();
    });

    var loadSample = document.querySelector('[data-action="load-sample"]');
    if (loadSample) loadSample.addEventListener("click", function () {
      persist(function (next) {
        next.contracts = JSON.parse(JSON.stringify(SAMPLE_CONTRACTS));
        next.entities = DEFAULT_ENTITIES.slice();
      }, "toast_sample_loaded");
    });

    var exportBtn = document.querySelector('[data-action="export"]');
    if (exportBtn) exportBtn.addEventListener("click", exportData);

    var importBtn = document.querySelector('[data-action="import"]');
    var importInput = document.getElementById("import-input");
    if (importBtn && importInput) {
      importBtn.addEventListener("click", function () { importInput.click(); });
      importInput.addEventListener("change", function () {
        if (importInput.files && importInput.files[0]) importData(importInput.files[0]);
        importInput.value = "";
      });
    }

    var clearAllBtn = document.querySelector('[data-action="clear-all"]');
    if (clearAllBtn) clearAllBtn.addEventListener("click", function () { UI.modal = { mode: "clear-all" }; render(); });
    var confirmClearAll = document.querySelector('[data-action="confirm-clear-all"]');
    if (confirmClearAll) confirmClearAll.addEventListener("click", function () {
      persist(function (next) { next.contracts = []; }, "toast_cleared");
    });

    document.querySelectorAll('[data-action="edit"]').forEach(function (el) {
      el.addEventListener("click", function () { UI.modal = { mode: "edit", id: el.getAttribute("data-id") }; render(); });
    });
    document.querySelectorAll('[data-action="delete"]').forEach(function (el) {
      el.addEventListener("click", function () { UI.modal = { mode: "delete", id: el.getAttribute("data-id") }; render(); });
    });
    function closeModal() {
      UI.modal = (UI.modal && UI.modal.mode === "manage-entities" && UI.modal.returnTo) ? UI.modal.returnTo : null;
      render();
    }
    document.querySelectorAll('[data-action="close-modal"]').forEach(function (el) {
      el.addEventListener("click", closeModal);
    });
    var overlay = document.querySelector("[data-overlay]");
    if (overlay) overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });

    document.querySelectorAll('[data-action="manage-entities"]').forEach(function (el) {
      el.addEventListener("click", function () {
        var returnTo = (UI.modal && (UI.modal.mode === "add" || UI.modal.mode === "edit")) ? UI.modal : null;
        UI.modal = { mode: "manage-entities", returnTo: returnTo };
        render();
      });
    });

    var entityAddInput = document.getElementById("entity-add-input");
    function doAddEntity() {
      if (!entityAddInput) return;
      var name = entityAddInput.value.trim();
      if (!name) { showToast(t("entities_empty_name")); return; }
      var exists = STATE.entities.some(function (e) { return e.toLowerCase() === name.toLowerCase(); });
      if (exists) { showToast(t("entities_duplicate")); return; }
      mutateEntitiesState(function (next) { next.entities.push(name); });
    }
    var entityAddBtn = document.querySelector('[data-action="entity-add"]');
    if (entityAddBtn) entityAddBtn.addEventListener("click", doAddEntity);
    if (entityAddInput) entityAddInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doAddEntity(); } });

    document.querySelectorAll('[data-action="entity-rename"]').forEach(function (el) {
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
      el.addEventListener("change", function () {
        var idx = Number(el.getAttribute("data-index"));
        var oldName = STATE.entities[idx];
        var newName = el.value.trim();
        if (!newName || newName === oldName) { el.value = oldName; return; }
        var dup = STATE.entities.some(function (e, i) { return i !== idx && e.toLowerCase() === newName.toLowerCase(); });
        if (dup) { showToast(t("entities_duplicate")); el.value = oldName; return; }
        // Saved silently (no re-render): the input already shows the typed value,
        // and re-rendering here would destroy focus on whatever field the user clicks next.
        var next = JSON.parse(JSON.stringify(STATE));
        next.entities[idx] = newName;
        next.contracts.forEach(function (c) { if (c.entity === oldName) c.entity = newName; });
        STATE = next;
        saveState(STATE);
      });
    });

    document.querySelectorAll('[data-action="entity-delete"]').forEach(function (el) {
      el.addEventListener("click", function () {
        var idx = Number(el.getAttribute("data-index"));
        var name = STATE.entities[idx];
        var count = STATE.contracts.filter(function (c) { return c.entity === name; }).length;
        if (count > 0) {
          showToast('"' + name + '" ' + t("entities_delete_blocked") + " " + count + " " + t("entities_delete_blocked_suffix"));
          return;
        }
        mutateEntitiesState(function (next) { next.entities.splice(idx, 1); });
      });
    });

    var confirmDel = document.querySelector('[data-action="confirm-delete"]');
    if (confirmDel) confirmDel.addEventListener("click", function () {
      var id = confirmDel.getAttribute("data-id");
      persist(function (next) { next.contracts = next.contracts.filter(function (c) { return c.id !== id; }); }, "toast_deleted");
    });

    var searchBox = document.getElementById("search-box");
    if (searchBox) {
      searchBox.addEventListener("input", function () {
        UI.search = searchBox.value;
        var pos = searchBox.selectionStart;
        render();
        var again = document.getElementById("search-box");
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      });
    }
    var statusFilter = document.getElementById("status-filter");
    if (statusFilter) statusFilter.addEventListener("change", function () { UI.statusFilter = statusFilter.value; render(); });
    var riskFilter = document.getElementById("risk-filter");
    if (riskFilter) riskFilter.addEventListener("change", function () { UI.riskFilter = riskFilter.value; render(); });

    var form = document.getElementById("contract-form");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var fd = new FormData(form);
        var data = {};
        fd.forEach(function (v, k) { data[k] = v; });
        if (!data.title || !data.entity || !data.contractType) {
          showToast(t("toast_required"));
          return;
        }
        data.value = data.value ? Number(data.value) : null;
        data.noticeDays = data.noticeDays ? Number(data.noticeDays) : null;

        if (UI.modal.mode === "edit") {
          var id = UI.modal.id;
          persist(function (next) {
            var idx = next.contracts.findIndex(function (c) { return c.id === id; });
            if (idx !== -1) next.contracts[idx] = Object.assign({}, next.contracts[idx], data);
          }, "toast_updated");
        } else {
          persist(function (next) {
            data.id = nextContractId(next.contracts);
            next.contracts.push(data);
          }, "toast_added");
        }
      });
    }
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !UI.modal) return;
    UI.modal = (UI.modal.mode === "manage-entities" && UI.modal.returnTo) ? UI.modal.returnTo : null;
    render();
  });

  render();
})();
