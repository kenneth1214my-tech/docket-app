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

  // Free-text fields standardized to uppercase (logistics/customs-doc
  // convention). Select fields are left alone - their values are exact
  // taxonomy strings and uppercasing would break every lookup against them.
  var UPPERCASE_FIELDS = ["title", "counterparty", "paymentTerms", "governingLaw", "obligations", "terminationClause", "liabilityNotes", "tags", "notes"];

  // Applied on every load, not just on save, so records created before this
  // rule existed (or brought in via JSON import) get normalized too, instead
  // of being stuck in mixed case until someone happens to re-edit them.
  function normalizeContractCase(c) {
    var changed = false;
    UPPERCASE_FIELDS.forEach(function (k) {
      if (typeof c[k] === "string" && c[k] !== c[k].toUpperCase()) { c[k] = c[k].toUpperCase(); changed = true; }
    });
    return changed;
  }

  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return JSON.parse(JSON.stringify(EMPTY_STATE));
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.contracts)) return JSON.parse(JSON.stringify(EMPTY_STATE));
      if (!Array.isArray(parsed.entities) || !parsed.entities.length) parsed.entities = DEFAULT_ENTITIES.slice();
      var anyChanged = false;
      parsed.contracts.forEach(function (c) { if (normalizeContractCase(c)) anyChanged = true; });
      if (anyChanged) {
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch (e) { /* ignore - still usable in memory */ }
      }
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

  // Kept out of STATE on purpose: never bundled into export/import JSON.
  var AI_KEY_STORAGE = "docket_ai_key_v1";
  function loadAiKey() {
    try { return window.localStorage.getItem(AI_KEY_STORAGE) || ""; } catch (e) { return ""; }
  }
  function saveAiKey(key) {
    try {
      if (key) window.localStorage.setItem(AI_KEY_STORAGE, key);
      else window.localStorage.removeItem(AI_KEY_STORAGE);
    } catch (e) { /* ignore */ }
  }

  var STATE = loadState();
  var UI = {
    view: sessionStorage.getItem("docket_ui_view") || "dashboard",
    lang: loadLang(),
    search: "",
    statusFilter: "all",
    riskFilter: "all",
    alertFilter: "all", // set only by dashboard clicks - no dropdown of its own
    contractTypeFilter: "all", // set only by dashboard clicks - no dropdown of its own
    currencyFilter: "all", // set only by dashboard clicks - no dropdown of its own
    modal: null
  };

  // Every dashboard click routes through here: switches to the register and
  // replaces the whole filter set (rather than merging), so one click can't
  // leave a stale filter from a previous click combined in unexpectedly.
  function gotoRegisterFiltered(opts) {
    opts = opts || {};
    UI.view = "register";
    UI.search = "";
    UI.statusFilter = opts.status || "all";
    UI.riskFilter = opts.risk || "all";
    UI.alertFilter = opts.alert || "all";
    UI.contractTypeFilter = opts.type || "all";
    UI.currencyFilter = opts.currency || "all";
    sessionStorage.setItem("docket_ui_view", UI.view);
    render();
  }

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

  function exportExcel() {
    if (!window.XLSX) { showToast(t("toast_excel_lib_missing")); return; }
    var headers = ["ID", t("f_title"), t("col_entity"), t("f_counterparty"), t("f_counterpartyType"), t("f_department"),
      t("f_contractType"), t("f_riskTier"), t("f_confidentiality"), t("f_status"),
      t("f_startDate"), t("f_expiryDate"), t("col_alert"), t("f_autoRenewal"), t("f_noticeDays"),
      t("f_value"), t("f_currency"), t("f_paymentTerms"), t("f_governingLaw"),
      t("f_obligations"), t("f_terminationClause"), t("f_liabilityNotes"), t("f_tags"), t("f_notes"),
      t("view_original_document")];
    var rows = STATE.contracts.map(function (c) {
      var a = computeAlert(c);
      return [
        c.id, c.title || "", tx(c.entity) || "", c.counterparty || "", tx(c.counterpartyType) || "",
        tx(c.department) || "", tx(c.contractType) || "", tx(c.riskTier) || "", tx(c.confidentiality) || "",
        tx(c.status) || "", c.startDate ? new Date(c.startDate + "T00:00:00") : "",
        c.expiryDate ? new Date(c.expiryDate + "T00:00:00") : "", a.label || "", tx(c.autoRenewal) || "",
        c.noticeDays != null && c.noticeDays !== "" ? Number(c.noticeDays) : "",
        c.value != null && c.value !== "" ? Number(c.value) : "", c.currency || "", c.paymentTerms || "",
        c.governingLaw || "", c.obligations || "", c.terminationClause || "", c.liabilityNotes || "",
        c.tags || "", c.notes || "", c.fileUrl || ""
      ];
    });
    var aoa = [headers].concat(rows);
    var ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = headers.map(function (h) { return { wch: Math.max(10, Math.min(32, String(h).length + 4)) }; });
    var wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Contracts");
    window.XLSX.writeFile(wb, "docket-contracts-" + new Date().toISOString().slice(0, 10) + ".xlsx");
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.contracts)) throw new Error("File does not look like a Docket export.");
        persist(function (next) {
          next.contracts = parsed.contracts;
          if (Array.isArray(parsed.entities) && parsed.entities.length) next.entities = parsed.entities;
        }, "toast_imported");
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
            '<button class="link-btn" data-action="ai-settings">' + esc(t("ai_settings")) + "</button>" +
            '<button class="link-btn" data-action="export">' + esc(t("export_data")) + "</button>" +
            '<button class="link-btn" data-action="export-excel">' + esc(t("export_excel")) + "</button>" +
            '<button class="link-btn" data-action="import">' + esc(t("import_data")) + "</button>" +
            (STATE.contracts.length === 0 ? '<button class="link-btn" data-action="load-sample">' + esc(t("load_sample")) + "</button>" : '<button class="link-btn" data-action="clear-all">' + esc(t("clear_all")) + "</button>") +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  // Every dashboard element that jumps to a filtered register view shares
  // this one set of data-* attributes, read back generically in bindEvents.
  function filterDataAttrs(opts) {
    opts = opts || {};
    var attrs = ' data-action="goto-register"';
    if (opts.status) attrs += ' data-status="' + esc(opts.status) + '"';
    if (opts.risk) attrs += ' data-risk="' + esc(opts.risk) + '"';
    if (opts.alert) attrs += ' data-alert="' + esc(opts.alert) + '"';
    if (opts.type) attrs += ' data-type="' + esc(opts.type) + '"';
    if (opts.currency) attrs += ' data-currency="' + esc(opts.currency) + '"';
    return attrs;
  }

  function kpi(label, value, iconKey, tone, filterOpts) {
    return '<button type="button" class="kpi' + (tone ? " tone-" + tone : "") + '"' + filterDataAttrs(filterOpts) + '><div class="label-row"><div class="label">' + esc(label) + "</div>" +
      (iconKey ? '<span class="kpi-icon">' + KPI_ICONS[iconKey] + "</span>" : "") +
      '</div><div class="value">' + value + "</div></button>";
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
        kpi(t("kpi_total"), total, "total", null, {}) +
        kpi(t("kpi_active"), active, "active", "success", { status: "Active" }) +
        kpi(t("kpi_expiring"), expiringSoon, "clock", expiringSoon > 0 ? "warning" : null, { status: "Expiring Soon" }) +
        kpi(t("kpi_overdue"), overdueOrExpired, "alert", overdueOrExpired > 0 ? "danger" : null, { alert: "overdue_or_expired" }) +
        kpi(t("kpi_critical"), criticalRisk, "shield", criticalRisk > 0 ? "danger" : null, { risk: "Critical" }) +
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
          return '<li class="clickable" role="button" tabindex="0" data-action="edit" data-id="' + esc(x.c.id) + '"><span class="rank">#' + (i + 1) + '</span>' +
            '<div class="info"><div class="t">' + esc(x.c.title) + '</div><div class="s">' + esc(x.c.counterparty) + " · " + esc(tx(x.c.entity)) + "</div></div>" +
            '<span class="pill alert-' + x.a.key + '">' + esc(x.a.label) + "</span></li>";
        }).join("") + "</ul>" : '<div class="empty-state" style="padding:24px"><p>' + esc(t("soonest_empty")) + "</p></div>") +
      "</div>" +
      '<div class="panel">' +
        '<div class="panel-head"><h2>' + esc(t("value_title")) + "</h2></div>" +
        '<div class="panel-body table-wrap"><table><thead><tr><th>' + esc(t("col_currency")) + '</th><th class="num">' + esc(t("col_total_value")) + "</th></tr></thead><tbody>" +
        (Object.keys(byCurrency).length ? Object.keys(byCurrency).map(function (k) {
          return '<tr class="clickable-row" role="button" tabindex="0"' + filterDataAttrs({ status: "Active", currency: k }) + "><td>" + esc(k) + '</td><td class="num">' + fmtMoney(byCurrency[k], k) + "</td></tr>";
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
    return '<button type="button" class="radar-cell ' + key + '"' + filterDataAttrs({ alert: key }) + '><div class="n">' + n + '</div><div class="l">' + esc(label) + "</div></button>";
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

  function barRow(label, value, max, tone, filterOpts) {
    var pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0;
    return '<div class="bar-row clickable" role="button" tabindex="0"' + filterDataAttrs(filterOpts) + '><div class="bar-label" title="' + esc(label) + '">' + esc(label) + '</div>' +
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

    var typeCounts = {};
    TAXONOMY.contractTypes.forEach(function (ct) { typeCounts[ct] = 0; });
    cs.forEach(function (c) { if (typeCounts.hasOwnProperty(c.contractType)) typeCounts[c.contractType]++; });
    var typesUsed = TAXONOMY.contractTypes.filter(function (ct) { return typeCounts[ct] > 0; })
      .sort(function (a, b) { return typeCounts[b] - typeCounts[a]; });
    var maxType = Math.max.apply(null, typesUsed.map(function (ct) { return typeCounts[ct]; }).concat([1]));

    return (
      '<div class="panel">' +
        '<div class="panel-head"><h2>' + esc(t("portfolio_title")) + "</h2></div>" +
        '<div class="bar-list bar-columns">' +
          "<div>" +
            '<div class="bar-col-title">' + esc(t("col_status")) + "</div>" +
            statusesUsed.map(function (s) { return barRow(tx(s), statusCounts[s], maxStatus, statusTone(s), { status: s }); }).join("") +
          "</div>" +
          "<div>" +
            '<div class="bar-col-title">' + esc(t("col_risk")) + "</div>" +
            TAXONOMY.riskTiers.map(function (r) { return barRow(tx(r), riskCounts[r], maxRisk, riskTone(r), { risk: r }); }).join("") +
          "</div>" +
        "</div>" +
        (typesUsed.length ? '<div class="bar-list bar-type-list">' +
          '<div class="bar-col-title">' + esc(t("col_contract_type")) + "</div>" +
          typesUsed.map(function (ct) { return barRow(tx(ct), typeCounts[ct], maxType, "primary", { type: ct }); }).join("") +
        "</div>" : "") +
      "</div>"
    );
  }

  var ALERT_FILTER_LABEL_KEYS = { overdue: "radar_overdue", critical: "radar_critical", warning: "radar_warning", watch: "radar_watch", ok: "radar_ok", overdue_or_expired: "kpi_overdue" };
  function extraFilterLabel() {
    var parts = [];
    if (UI.alertFilter !== "all") parts.push(t(ALERT_FILTER_LABEL_KEYS[UI.alertFilter] || UI.alertFilter).split(" · ")[0]);
    if (UI.contractTypeFilter !== "all") parts.push(tx(UI.contractTypeFilter));
    if (UI.currencyFilter !== "all") parts.push(UI.currencyFilter);
    return parts.join(" · ");
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
    if (UI.contractTypeFilter !== "all") cs = cs.filter(function (c) { return c.contractType === UI.contractTypeFilter; });
    if (UI.currencyFilter !== "all") cs = cs.filter(function (c) { return c.currency === UI.currencyFilter; });
    if (UI.alertFilter !== "all") {
      cs = cs.filter(function (c) {
        var a = computeAlert(c);
        if (UI.alertFilter === "overdue_or_expired") return c.status === "Expired" || a.key === "overdue";
        return a.key === UI.alertFilter;
      });
    }

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
          (extraFilterLabel() ? '<span class="active-filter-chip">' + esc(extraFilterLabel()) + '<button type="button" data-action="clear-extra-filter" aria-label="' + esc(t("clear_filter")) + '">&times;</button></span>' : "") +
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
                (c.fileUrl ? '<a class="icon-btn" href="' + esc(c.fileUrl) + '" target="_blank" rel="noopener" title="' + esc(t("view_original_document")) + '"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.5h7l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M12 2.5v3h3"/></svg></a>' : "") +
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
    if (UI.modal.mode === "ai-settings") return renderAiSettingsModal();
    return renderFormModal();
  }

  function renderAiSettingsModal() {
    var key = loadAiKey();
    return (
      '<div class="modal-overlay" data-overlay>' +
        '<div class="modal">' +
          '<div class="modal-head"><h2>' + esc(t("ai_settings_title")) + "</h2><button class=\"icon-btn\" data-action=\"close-modal\" aria-label=\"" + esc(t("cancel")) + "\"><svg viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><path d=\"M5 5l10 10M15 5L5 15\"/></svg></button></div>" +
          '<div class="modal-body">' +
            '<div class="entities-hint">' + esc(t("ai_settings_hint")) + "</div>" +
            '<div class="field full"><label>' + esc(t("ai_settings_key_label")) + '</label><input type="password" id="ai-key-input" placeholder="sk-ant-..." value="' + esc(key) + '" autocomplete="off"></div>' +
            (key ? '<div class="ai-key-status">' + esc(t("ai_settings_key_saved")) + "</div>" : "") +
          "</div>" +
          '<div class="modal-foot">' +
            (key ? '<button type="button" class="btn btn-ghost" data-action="ai-key-clear">' + esc(t("ai_settings_clear")) + "</button>" : "") +
            '<button type="button" class="btn btn-primary" data-action="ai-key-save">' + esc(t("ai_settings_save")) + "</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    );
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
      var storageLine = "";
      if (m.fileUploadStatus === "uploading") storageLine = '<div class="upload-storage-status">' + esc(t("upload_storing")) + "</div>";
      else if (m.fileUploadStatus === "done") storageLine = '<div class="upload-storage-status ok">' + esc(t("upload_stored")) + "</div>";
      else if (m.fileUploadStatus === "error") storageLine = '<div class="upload-storage-status err">' + esc(t("upload_store_failed_prefix")) + esc(m.fileUploadError || "") + "</div>";
      return '<div class="upload-summary' + (count > 0 ? "" : " none") + '">' +
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.5h7l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M12 2.5v3h3"/></svg>' +
        '<div class="upload-summary-text">' + body + storageLine + "</div>" +
        '<button type="button" class="link-btn" data-action="upload-reset">' + esc(t("upload_clear")) + "</button>" +
      "</div>" +
      renderAiDraftRow();
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

  function renderAiDraftRow() {
    var hasKey = !!loadAiKey();
    return '<div class="ai-draft-row">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="ai-draft">' + esc(t("ai_draft_btn")) + "</button>" +
      '<span class="ai-draft-hint">' + esc(hasKey ? t("ai_draft_hint") : t("ai_draft_hint_no_key")) + "</span>" +
    "</div>";
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
            (editing && c.fileUrl ? '<a class="view-original-link" href="' + esc(c.fileUrl) + '" target="_blank" rel="noopener"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2.5h7l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M12 2.5v3h3"/></svg>' + esc(t("view_original_document")) + (c.fileName ? " (" + esc(c.fileName) + ")" : "") + "</a>" : "") +
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
          '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-action="close-modal">' + esc(t("cancel")) + '</button><button type="submit" class="btn btn-primary"' + (!editing && UI.modal.reading ? " disabled" : "") + '>' + (editing ? esc(t("save_changes")) : esc(t("add_contract_btn"))) + "</button></div>" +
          "</form>" +
        "</div>" +
      "</div>"
    );
  }

  // ---------- events ----------
  function openNewModal() { UI.modal = { mode: "add", draft: null, sourceFileName: null, reading: false, fieldsFound: 0 }; render(); }

  // Bot/abuse deterrent for /api/upload, not a real secret - this app has no
  // login, so the code is necessarily visible in the public client bundle.
  // Real cost protection is the server-side size/type checks in api/upload.js.
  var UPLOAD_ACCESS_CODE = "0Ipq64sUJZyluhCPqtrKwQj4";

  function uploadFileToBackend(file) {
    return fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
        "x-upload-code": UPLOAD_ACCESS_CODE
      },
      body: file
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || (res.status + " " + res.statusText));
        return data;
      });
    });
  }

  // Tesseract.js language codes for the app's non-English UI languages.
  // OCR always includes English (numbers, Latin boilerplate, common loanwords
  // in SEA business documents) plus the current UI language's script.
  var OCR_LANG_MAP = { zh: "chi_sim", ms: "msa", ko: "kor", ja: "jpn", id: "ind", tl: "fil" };
  function ocrLangFor(lang) {
    var extra = OCR_LANG_MAP[lang];
    return extra ? "eng+" + extra : "eng";
  }

  function normalizeCompanyName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  }

  // The pattern-matcher just grabs the first company-style name it finds in
  // reading order - on a "BETWEEN [Us] AND [Them]" recital, or a letterhead
  // that names us first, that's our own entity, not the counterparty. Since
  // extract.js has no idea which name is ours, fix it up here where we do.
  function fixCounterpartyGuess(result) {
    var guess = result.guess, companies = result.companies || [];
    if (!guess.counterparty) return;
    var ownNames = STATE.entities.filter(function (e) { return e && DEFAULT_ENTITIES.indexOf(e) === -1; }).map(normalizeCompanyName);
    if (!ownNames.length) return;
    var isOwnEntity = function (name) {
      var n = normalizeCompanyName(name);
      if (!n) return false;
      return ownNames.some(function (own) { return own && (own.indexOf(n) !== -1 || n.indexOf(own) !== -1); });
    };
    if (!isOwnEntity(guess.counterparty)) return;
    var alt = companies.find(function (c) { return !isOwnEntity(c); });
    if (alt) {
      guess.counterparty = alt;
    } else {
      delete guess.counterparty; // no confident alternative - blank beats wrong
      result.fieldsFound = Math.max(0, (result.fieldsFound || 0) - 1);
    }
  }

  function handleUploadedFile(file) {
    if (!UI.modal || UI.modal.mode !== "add") return;
    var ext = file.name.split(".").pop().toLowerCase();
    if (["pdf", "docx", "txt", "jpg", "jpeg", "png", "webp", "bmp"].indexOf(ext) === -1) {
      showToast(t("upload_unsupported"));
      return;
    }
    var modalRef = UI.modal;
    modalRef.reading = true;
    modalRef.ocrLabel = null;
    modalRef.ocrPct = null;
    modalRef.fileUrl = null;
    modalRef.fileUploadStatus = "uploading";
    modalRef.fileUploadError = null;
    render();

    // Runs alongside text extraction, not after it - storing the original
    // document doesn't depend on what the pattern-matcher finds in it.
    uploadFileToBackend(file).then(function (result) {
      if (UI.modal !== modalRef) return; // user moved on (closed/cancelled) before this resolved
      modalRef.fileUrl = result.url;
      modalRef.fileUploadStatus = "done";
      render();
    }).catch(function (err) {
      if (UI.modal !== modalRef) return;
      modalRef.fileUploadStatus = "error";
      modalRef.fileUploadError = err && err.message ? err.message : String(err);
      render();
    });

    var lastRenderAt = 0;
    function onProgress(label, fraction) {
      modalRef.ocrLabel = label;
      modalRef.ocrPct = Math.round((fraction || 0) * 100);
      var now = Date.now();
      if (now - lastRenderAt > 200) { lastRenderAt = now; render(); } // throttle - OCR fires progress very frequently
    }

    window.DocketExtract.extractText(file, onProgress, ocrLangFor(UI.lang)).then(function (text) {
      var result = window.DocketExtract.guessFields(text);
      if (UI.modal !== modalRef) return;
      fixCounterpartyGuess(result);
      modalRef.reading = false;
      modalRef.draft = result.guess;
      modalRef.sourceFileName = file.name;
      modalRef.fieldsFound = result.fieldsFound;
      modalRef.extractedText = text;
      render();
    }).catch(function (err) {
      if (UI.modal !== modalRef) return;
      modalRef.reading = false;
      render();
      var msg = (err && err.message === "UNSUPPORTED_TYPE") ? t("upload_unsupported") : t("upload_failed_prefix") + (err && err.message ? err.message : String(err));
      showToast(msg);
    });
  }

  // ---------- optional AI drafting (Anthropic API, called directly from the browser) ----------
  var CLAUDE_MODEL = "claude-haiku-4-5-20251001";
  var CLAUDE_MAX_CHARS = 12000; // keeps the request small/cheap - these fields don't need the whole document

  var AI_SELECT_FIELDS = {
    contractType: TAXONOMY.contractTypes,
    department: TAXONOMY.departments,
    riskTier: TAXONOMY.riskTiers,
    confidentiality: TAXONOMY.confidentiality,
    counterpartyType: TAXONOMY.counterpartyTypes,
    currency: TAXONOMY.currencies,
    autoRenewal: ["Yes", "No"]
  };
  var AI_TEXT_FIELDS = ["title", "counterparty", "governingLaw", "paymentTerms", "obligations", "terminationClause", "liabilityNotes", "tags"];
  var AI_DATE_FIELDS = ["startDate", "expiryDate"];
  var AI_NUMBER_FIELDS = ["value", "noticeDays"];

  function callClaudeDraft(key, text) {
    var trimmed = text.length > CLAUDE_MAX_CHARS ? text.slice(0, CLAUDE_MAX_CHARS) : text;
    var selectInstructions = Object.keys(AI_SELECT_FIELDS).map(function (k) {
      return k + " (pick exactly one of: " + AI_SELECT_FIELDS[k].join(" | ") + " - empty string if you can't tell)";
    }).join(", ");
    var ownNames = STATE.entities.filter(function (e) { return e && DEFAULT_ENTITIES.indexOf(e) === -1; });
    var ownNamesNote = ownNames.length
      ? "Our own company is one of: " + ownNames.join(" | ") + " - never put one of these into counterparty. "
      : "";
    var prompt = "You are filling in a contract-register form from the contract text below. " +
      ownNamesNote +
      "Return ONLY a JSON object (no markdown, no commentary) with these keys:\n" +
      "title (the contract's name/title), counterparty (the other party's full legal name, not our own entity), " +
      "governingLaw (the jurisdiction whose laws govern the contract), paymentTerms (e.g. \"Net 30\"), " +
      "startDate and expiryDate (ISO format YYYY-MM-DD, compute expiryDate from a stated term length plus startDate if no explicit expiry date is given), " +
      "value (the main contract value as a plain number, no currency symbols or commas), " +
      "noticeDays (the termination notice period in days, as a plain number), " +
      selectInstructions + ", " +
      "obligations (1-3 sentence plain-English summary of each party's main obligations), " +
      "terminationClause (1-2 sentence summary of how/when the contract can be terminated), " +
      "liabilityNotes (1-2 sentence summary of liability caps, indemnities, or insurance requirements), " +
      "tags (a short comma-separated list of 3-6 lowercase keywords for this contract). " +
      "If the text does not contain enough information for a field, use an empty string for that field. Never guess a select-type field value outside the exact list given.\n\nContract text:\n\n" + trimmed;

    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return null; }).then(function (body) {
          var msg = (body && body.error && body.error.message) || (res.status + " " + res.statusText);
          throw new Error(msg);
        });
      }
      return res.json();
    }).then(function (data) {
      var raw = (data.content && data.content[0] && data.content[0].text) || "";
      var jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Could not parse the AI response.");
      var parsed = JSON.parse(jsonMatch[0]);
      var out = {};
      AI_TEXT_FIELDS.forEach(function (k) {
        if (typeof parsed[k] === "string" && parsed[k].trim()) out[k] = parsed[k].trim();
      });
      AI_DATE_FIELDS.forEach(function (k) {
        if (typeof parsed[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed[k].trim())) out[k] = parsed[k].trim();
      });
      AI_NUMBER_FIELDS.forEach(function (k) {
        var n = Number(parsed[k]);
        if (parsed[k] !== "" && parsed[k] != null && !isNaN(n)) out[k] = n;
      });
      Object.keys(AI_SELECT_FIELDS).forEach(function (k) {
        if (typeof parsed[k] === "string" && AI_SELECT_FIELDS[k].indexOf(parsed[k].trim()) !== -1) out[k] = parsed[k].trim();
      });
      return out;
    });
  }

  function applyAiDraftToForm(fields) {
    var form = document.getElementById("contract-form");
    if (!form) return;
    Object.keys(fields).forEach(function (name) {
      var el = form.querySelector('[name="' + name + '"]');
      if (!el || el.value) return; // never clobber a value pattern-matching or the user already filled in
      if (el.tagName === "SELECT") {
        var matches = Array.prototype.some.call(el.options, function (o) { return o.value === String(fields[name]); });
        if (!matches) return;
      }
      el.value = fields[name];
    });
  }

  // Toggles the button in place rather than calling render(), so any manually
  // typed field values elsewhere in the still-open form are never overwritten.
  function setAiButtonBusy(busy) {
    var btn = document.querySelector('[data-action="ai-draft"]');
    if (btn) { btn.disabled = busy; btn.textContent = busy ? t("ai_drafting") : t("ai_draft_btn"); }
  }

  function bindEvents() {
    document.querySelectorAll("[data-nav]").forEach(function (el) {
      el.addEventListener("click", function () {
        UI.view = el.getAttribute("data-nav");
        sessionStorage.setItem("docket_ui_view", UI.view);
        render();
      });
    });

    document.querySelectorAll('[data-action="goto-register"]').forEach(function (el) {
      el.addEventListener("click", function () {
        gotoRegisterFiltered({
          status: el.getAttribute("data-status"),
          risk: el.getAttribute("data-risk"),
          alert: el.getAttribute("data-alert"),
          type: el.getAttribute("data-type"),
          currency: el.getAttribute("data-currency")
        });
      });
    });
    // Keyboard activation for the non-<button> clickable elements (bar rows,
    // the currency table's rows) - real <button>s already do this natively,
    // so this is scoped to only the ones we explicitly marked role="button".
    document.querySelectorAll('[data-action="goto-register"][role="button"], [data-action="edit"][role="button"]').forEach(function (el) {
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); }
      });
    });
    var clearExtraFilterBtn = document.querySelector('[data-action="clear-extra-filter"]');
    if (clearExtraFilterBtn) clearExtraFilterBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      UI.alertFilter = "all"; UI.contractTypeFilter = "all"; UI.currencyFilter = "all";
      render();
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
      UI.modal.draft = null; UI.modal.sourceFileName = null; UI.modal.fieldsFound = 0; UI.modal.extractedText = null;
      UI.modal.fileUrl = null; UI.modal.fileUploadStatus = null; UI.modal.fileUploadError = null;
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
    var exportExcelBtn = document.querySelector('[data-action="export-excel"]');
    if (exportExcelBtn) exportExcelBtn.addEventListener("click", exportExcel);

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
      UI.modal = (UI.modal && UI.modal.returnTo) ? UI.modal.returnTo : null;
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

    document.querySelectorAll('[data-action="ai-settings"]').forEach(function (el) {
      el.addEventListener("click", function () {
        var returnTo = (UI.modal && (UI.modal.mode === "add" || UI.modal.mode === "edit")) ? UI.modal : null;
        UI.modal = { mode: "ai-settings", returnTo: returnTo };
        render();
      });
    });
    var aiKeySaveBtn = document.querySelector('[data-action="ai-key-save"]');
    if (aiKeySaveBtn) aiKeySaveBtn.addEventListener("click", function () {
      var input = document.getElementById("ai-key-input");
      var key = input ? input.value.trim() : "";
      if (!key) { showToast(t("ai_settings_empty")); return; }
      saveAiKey(key);
      var returnTo = UI.modal.returnTo || null;
      UI.modal = returnTo;
      render();
      showToast(t("ai_settings_saved_toast"));
    });
    var aiKeyClearBtn = document.querySelector('[data-action="ai-key-clear"]');
    if (aiKeyClearBtn) aiKeyClearBtn.addEventListener("click", function () {
      saveAiKey("");
      var returnTo = UI.modal.returnTo || null;
      UI.modal = returnTo;
      render();
      showToast(t("ai_settings_cleared_toast"));
    });

    var aiDraftBtn = document.querySelector('[data-action="ai-draft"]');
    if (aiDraftBtn) aiDraftBtn.addEventListener("click", function () {
      var key = loadAiKey();
      if (!key) {
        UI.modal = { mode: "ai-settings", returnTo: UI.modal };
        render();
        return;
      }
      var text = UI.modal.extractedText;
      if (!text) { showToast(t("ai_draft_no_text")); return; }
      setAiButtonBusy(true);
      callClaudeDraft(key, text).then(function (fields) {
        UI.modal.draft = Object.assign({}, UI.modal.draft, fields);
        applyAiDraftToForm(fields);
        setAiButtonBusy(false);
        showToast(t("ai_draft_success"));
      }).catch(function (err) {
        setAiButtonBusy(false);
        showToast(t("ai_draft_failed_prefix") + (err && err.message ? err.message : String(err)));
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
        normalizeContractCase(data);

        if (UI.modal.mode === "edit") {
          var id = UI.modal.id;
          persist(function (next) {
            var idx = next.contracts.findIndex(function (c) { return c.id === id; });
            if (idx !== -1) next.contracts[idx] = Object.assign({}, next.contracts[idx], data);
          }, "toast_updated");
        } else {
          if (UI.modal.fileUrl) { data.fileUrl = UI.modal.fileUrl; data.fileName = UI.modal.sourceFileName; }
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
    UI.modal = UI.modal.returnTo || null;
    render();
  });

  render();
})();
