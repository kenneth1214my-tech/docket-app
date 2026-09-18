// Docket e-signature module. Adapted from a tested client-only prototype -
// the PDF placement/signature UI below is unchanged from that prototype.
// What changed is everything about persistence and email: instead of an
// unverifiable capability call from inside a sandboxed page, every send goes
// through this app's own serverless API (api/esign-*.js), which calls
// Resend server-side and reports back Resend's real HTTP response. A "Sent"
// status here is therefore trustworthy in a way the prototype's never was.
(function () {
  // pdf.js loads as an ES module in a separate <script type="module"> tag
  // (see esign.html), which - unlike the classic <script> this file is -
  // executes deferred, after this file's own top-level code has already
  // run. window.pdfjsLib is therefore not guaranteed to exist yet at parse
  // time; every call site awaits this first instead of touching it directly.
  function ensurePdfjs() {
    return new Promise(function (resolve) {
      (function poll() {
        if (window.pdfjsLib) {
          if (!ensurePdfjs._ready) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs";
            ensurePdfjs._ready = true;
          }
          resolve(window.pdfjsLib);
        } else {
          setTimeout(poll, 30);
        }
      })();
    });
  }

  var BOX_W = 70, BOX_H = 14, MARGIN_RIGHT = 20, MARGIN_BOTTOM = 6;
  var UPLOAD_ACCESS_CODE = "0Ipq64sUJZyluhCPqtrKwQj4"; // same public abuse deterrent as app.js

  var state = {
    fileBytes: null, fileName: "", fileHashHex: "",
    pdfjsDoc: null, pageCount: 0, pageIncluded: [], includePageStamp: true,
    preparerEmail: null, receiverEmail: null,
    currentDocId: null, receiverOnlyMode: false, step: 1,
    activeBlockKey: "preparer", activeReceiverPlacement: "approved",
    blocks: { preparer: blankBlock("Prepared by"), approver: blankBlock("Approved by (Receiver)"), receiver: blankBlock("Receiver") },
    bigPreviewScale: 1, bigPreviewPageWidth: 0, bigPreviewPageHeight: 0
  };

  function blankBlock(label) {
    return { label: label, pageIndex: 0, nameValue: "", initials: "", sigDataUrl: null, hasStrokes: false, signedAt: null,
      namePos: null, sigPos: null, datePos: null, nameBoxW: 130, nameBoxH: 14, sigBoxW: 120, sigBoxH: 34, dateBoxW: 80, dateBoxH: 14 };
  }

  // ---------- backend access ----------
  var session = null; // {id,email,name,role} or null

  async function loadSession() {
    try {
      var r = await fetch("/api/me");
      if (!r.ok) { session = null; return null; }
      session = await r.json();
      return session;
    } catch (e) { session = null; return null; }
  }

  function uploadFileToBackend(fileOrBlob, name) {
    if (!window.VercelBlobUpload) return Promise.reject(new Error("Upload library did not load - check your connection and try again."));
    return window.VercelBlobUpload("esign/" + Date.now() + "-" + (name || "document.pdf"), fileOrBlob, {
      access: "public", handleUploadUrl: "/api/upload",
      clientPayload: JSON.stringify({ code: UPLOAD_ACCESS_CODE })
    }).then(function (blob) { return blob.url; });
  }

  async function apiPost(path, body) {
    var r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) { var err = new Error(data.error || (r.status + " " + r.statusText)); err.status = r.status; throw err; }
    return data;
  }
  async function apiGet(path) {
    var r = await fetch(path);
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) { var err = new Error(data.error || (r.status + " " + r.statusText)); err.status = r.status; throw err; }
    return data;
  }

  function docLinkFor(id) {
    var url = new URL(window.location.href);
    url.searchParams.set("id", id);
    return url.toString();
  }
  function urlDocId() { return new URLSearchParams(window.location.search).get("id"); }
  function goToDashboard() {
    var url = new URL(window.location.href);
    url.searchParams.delete("id");
    window.location.href = url.toString();
  }

  function showOnly(ids) {
    var all = ["step1", "step2", "step3", "step4", "modeDashboard", "modeAwaiting", "modeReceiverIntro", "modeReceiverSubmitted", "modeReviewFinalize", "modeCompleted", "modeLoggedOut"];
    all.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = ids.indexOf(id) === -1 ? "none" : "";
    });
    var isLinearStep = !state.receiverOnlyMode && ids.some(function (id) { return /^step[1-4]$/.test(id); });
    document.getElementById("stepPills").style.display = isLinearStep ? "" : "none";
    var showAllDocs = !!session && !state.receiverOnlyMode && ids.indexOf("modeDashboard") === -1;
    document.getElementById("allDocsLink").style.display = showAllDocs ? "" : "none";
  }

  var steps = [{ n: 1, label: "Upload" }, { n: 2, label: "Fields" }, { n: 3, label: "Sign" }, { n: 4, label: "Finish" }];
  function renderStepPills() {
    var el = document.getElementById("stepPills");
    el.innerHTML = "";
    steps.forEach(function (s) {
      var pill = document.createElement("div");
      pill.className = "step-pill" + (s.n === state.step ? " active" : (s.n < state.step ? " done" : ""));
      pill.innerHTML = '<span class="step-num">' + (s.n < state.step ? "✓" : s.n) + "</span>" + s.label;
      el.appendChild(pill);
    });
  }
  function goToStep(n) { state.step = n; showOnly(["step" + n]); renderStepPills(); if (n === 4) renderCertPreview(); }
  function setStatus(id, msg, cls) {
    var el = document.getElementById(id);
    el.textContent = msg || "";
    el.className = "status-line" + (cls ? " " + cls : "");
  }
  async function sha256Hex(buf) {
    var digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  function fmtBytes(n) { if (n < 1024) return n + " B"; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB"; return (n / (1024 * 1024)).toFixed(2) + " MB"; }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  // ---------- STEP 1: upload ----------
  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  dropzone.addEventListener("click", function () { fileInput.click(); });
  ["dragenter", "dragover"].forEach(function (evt) { dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add("drag"); }); });
  ["dragleave", "drop"].forEach(function (evt) { dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove("drag"); }); });
  dropzone.addEventListener("drop", function (e) { var f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });
  fileInput.addEventListener("change", function (e) { var f = e.target.files && e.target.files[0]; if (f) handleFile(f); });

  var uploadedFile = null;

  async function handleFile(file) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setStatus("uploadStatus", "That doesn't look like a PDF — please choose a .pdf file.", "err");
      return;
    }
    setStatus("uploadStatus", "Loading…");
    try {
      uploadedFile = file;
      var arrayBuf = await file.arrayBuffer();
      state.fileBytes = new Uint8Array(arrayBuf);
      state.fileName = file.name;
      state.fileHashHex = await sha256Hex(arrayBuf);
      var pdfjs = await ensurePdfjs();
      var loadingTask = pdfjs.getDocument({ data: state.fileBytes.slice() });
      state.pdfjsDoc = await loadingTask.promise;
      state.pageCount = state.pdfjsDoc.numPages;
      state.pageIncluded = new Array(state.pageCount).fill(true);
      setStatus("uploadStatus", "", "");
      buildFileSummary(file);
      await buildPageGrid();
      await setupRoleBlocks();
      goToStep(2);
    } catch (err) {
      console.error(err);
      setStatus("uploadStatus", "Couldn't read that PDF (" + err.message + "). Try a different file.", "err");
    }
  }

  function buildFileSummary(file) {
    document.getElementById("fileSummary").innerHTML =
      '<div style="font-size:20px;">📄</div><div><div class="name">' + escapeHtml(state.fileName) + '</div>' +
      '<div class="meta">' + state.pageCount + " page" + (state.pageCount === 1 ? "" : "s") + " · " + fmtBytes(file.size) + "</div></div>";
  }

  // ---------- STEP 2: page grid ----------
  async function buildPageGrid() {
    var grid = document.getElementById("pageGrid");
    grid.innerHTML = "";
    for (var i = 1; i <= state.pageCount; i++) {
      var page = await state.pdfjsDoc.getPage(i);
      var viewportBase = page.getViewport({ scale: 1 });
      var targetWidth = 260;
      var scale = targetWidth / viewportBase.width;
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement("canvas");
      canvas.width = viewport.width; canvas.height = viewport.height;
      var ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;

      var pageCard = document.createElement("div");
      pageCard.className = "page-card";
      var canvasWrap = document.createElement("div");
      canvasWrap.className = "page-canvas-wrap";
      canvasWrap.appendChild(canvas);

      var pw = viewportBase.width, ph = viewportBase.height;
      var overlay = document.createElement("div");
      overlay.className = "field-overlay" + (state.pageIncluded[i - 1] ? "" : " disabled");
      overlay.style.right = (MARGIN_RIGHT / pw) * 100 + "%";
      overlay.style.width = (BOX_W / pw) * 100 + "%";
      overlay.style.bottom = (MARGIN_BOTTOM / ph) * 100 + "%";
      overlay.style.height = (BOX_H / ph) * 100 + "%";
      overlay.dataset.pageIndex = i - 1;
      canvasWrap.appendChild(overlay);

      var controls = document.createElement("div");
      controls.className = "page-controls";
      controls.innerHTML = "<span>Page " + i + '</span><label><input type="checkbox" data-page="' + (i - 1) + '" ' + (state.pageIncluded[i - 1] ? "checked" : "") + "> Initial here</label>";

      pageCard.appendChild(canvasWrap); pageCard.appendChild(controls); grid.appendChild(pageCard);
    }
    grid.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener("change", function (e) {
        var idx = parseInt(e.target.dataset.page, 10);
        state.pageIncluded[idx] = e.target.checked;
        var overlay = grid.querySelector('.field-overlay[data-page-index="' + idx + '"]');
        if (overlay) overlay.classList.toggle("disabled", !e.target.checked);
        updatePageCountLabel();
      });
    });
    updatePageCountLabel();
  }
  function updatePageCountLabel() {
    var n = state.pageIncluded.filter(Boolean).length;
    document.getElementById("pageCountLabel").textContent = n > 0 ? "(will appear on " + n + " page" + (n === 1 ? "" : "s") + ")" : "(no pages selected)";
  }

  document.getElementById("backTo1").addEventListener("click", function () { document.getElementById("startOverLink").click(); });
  document.getElementById("toStep3").addEventListener("click", function () {
    if (state.pageIncluded.every(function (v) { return !v; })) { alert("Select at least one page to initial, or go back and pick a different document."); return; }
    goToStep(3); switchRole("preparer");
  });
  document.getElementById("includePageStamp").addEventListener("change", function (e) { state.includePageStamp = e.target.checked; });

  // ---------- STEP 3: role-based signing ----------
  var PLACEMENT_KEYS = ["preparer", "approver", "receiver"];
  var SIGNER_TABS = ["preparer", "receiver"];
  // Priority-ordered phrases to search for on each page - first phrase that
  // matches anywhere on a page wins for that page; pages are tried in order,
  // so the earliest page with any match is used. Broad enough to cover most
  // typed (non-scanned) contract templates without needing per-template
  // configuration; falls back to defaultRolePositions() when nothing matches.
  var ROLE_KEYWORDS = {
    preparer: ["prepared by", "for and on behalf of", "authorized signatory", "company representative", "signature of preparer"],
    approver: ["approved by", "reviewed by", "authorized by", "acknowledged by"]
  };
  var DATE_LABEL_KEYWORDS = ["date", "dated", "signed on"];

  function formatDateDisplay(d) { d = d || new Date(); return d.getDate() + "/" + (d.getMonth() + 1) + "/" + d.getFullYear(); }
  function todayDisplay() { return formatDateDisplay(new Date()); }
  function blockSignedDate(block) { return formatDateDisplay(block.signedAt ? new Date(block.signedAt) : new Date()); }
  function getIdentityBlock() { return state.activeBlockKey === "receiver" ? state.blocks.receiver : state.blocks.preparer; }
  function getPositionBlock() {
    if (state.activeBlockKey === "preparer") return state.blocks.preparer;
    return state.activeReceiverPlacement === "approved" ? state.blocks.approver : state.blocks.receiver;
  }

  async function setupRoleBlocks() {
    document.getElementById("todayDisplaySpan").textContent = todayDisplay();
    var select = document.getElementById("sigPageSelect");
    select.innerHTML = "";
    for (var i = 1; i <= state.pageCount; i++) {
      var opt = document.createElement("option"); opt.value = i - 1; opt.textContent = "Page " + i; select.appendChild(opt);
    }
    for (var k = 0; k < PLACEMENT_KEYS.length; k++) {
      var key = PLACEMENT_KEYS[k]; var block = state.blocks[key]; var guess = null;
      if (ROLE_KEYWORDS[key]) guess = await guessRolePositions(ROLE_KEYWORDS[key], block);
      if (!guess) guess = await defaultRolePositions(block, key === "receiver");
      block.pageIndex = guess.pageIndex; block.namePos = guess.namePos; block.sigPos = guess.sigPos; block.datePos = guess.datePos;
    }
    renderRoleTabs();
    select.addEventListener("change", function () {
      var block = getPositionBlock();
      block.pageIndex = parseInt(select.value, 10);
      defaultRolePositions(block, false).then(function (pos) {
        block.namePos = pos.namePos; block.sigPos = pos.sigPos; block.datePos = pos.datePos;
        renderBigPreview(block.pageIndex);
      });
    });
    document.getElementById("sigSizeSlider").addEventListener("input", function (e) {
      var w = parseInt(e.target.value, 10); var block = getPositionBlock();
      block.sigBoxW = w; block.sigBoxH = Math.round(w * 0.28); positionMarkers();
    });
    document.getElementById("roleNameInput").addEventListener("input", function (e) {
      getIdentityBlock().nameValue = e.target.value;
      if (state.activeBlockKey === "receiver") state.blocks.approver.nameValue = e.target.value;
      refreshMarkersContent();
    });
    document.getElementById("initialsInput").addEventListener("input", function (e) {
      if (state.activeBlockKey !== "receiver") return;
      state.blocks.receiver.initials = e.target.value.trim();
      state.blocks.approver.initials = state.blocks.receiver.initials;
    });
  }

  async function guessRolePositions(keywords, block) {
    var list = Array.isArray(keywords) ? keywords : [keywords];
    for (var i = 1; i <= state.pageCount; i++) {
      var page = await state.pdfjsDoc.getPage(i);
      var vp = page.getViewport({ scale: 1 });
      var content = await page.getTextContent();
      // Try each phrase in priority order against this page before moving on
      // to the next page - a higher-priority phrase on a later page still
      // loses to a lower-priority one found earlier, but signature blocks
      // are almost always clustered on one page, so this rarely matters.
      var item = null;
      for (var k = 0; k < list.length && !item; k++) {
        var kw = list[k];
        item = content.items.find(function (it) { return it.str && it.str.toLowerCase().includes(kw); });
      }
      if (!item) continue;
      var lx = item.transform[4], ly = item.transform[5];
      var sigW = block.sigBoxW, sigH = block.sigBoxH;
      var sigX = lx - 5, sigY = ly + 6;
      var nameW = block.nameBoxW, nameH = block.nameBoxH;
      var nameX = lx - 5, nameY = ly - 24;
      var dateX = sigX + sigW + 12, dateY = nameY - 20;
      var dateItem = content.items.find(function (it) {
        return it.str && DATE_LABEL_KEYWORDS.some(function (dk) { return it.str.toLowerCase().includes(dk); }) &&
          Math.abs(it.transform[4] - lx) < 100 && it.transform[5] < ly;
      });
      if (dateItem) { dateX = dateItem.transform[4]; dateY = dateItem.transform[5] - 2; }
      var clampX = function (v, w) { return Math.max(20, Math.min(v, vp.width - w - 20)); };
      var clampY = function (v, h) { return Math.max(20, Math.min(v, vp.height - h - 20)); };
      return { pageIndex: i - 1, sigPos: { x: clampX(sigX, sigW), y: clampY(sigY, sigH) }, namePos: { x: clampX(nameX, nameW), y: clampY(nameY, nameH) }, datePos: { x: clampX(dateX, block.dateBoxW), y: clampY(dateY, block.dateBoxH) } };
    }
    return null;
  }
  async function defaultRolePositions(block, isReceiver) {
    var pageIndex = isReceiver ? state.pageCount - 1 : block.pageIndex;
    var page = await state.pdfjsDoc.getPage(pageIndex + 1);
    var vp = page.getViewport({ scale: 1 });
    var baseX = (vp.width - block.sigBoxW) / 2, baseY = vp.height * 0.2;
    return { pageIndex: pageIndex, sigPos: { x: baseX, y: baseY + 24 }, namePos: { x: baseX, y: baseY + 6 }, datePos: { x: baseX + block.sigBoxW + 12, y: baseY + 10 } };
  }

  function renderRoleTabs() {
    var el = document.getElementById("roleTabs"); el.innerHTML = "";
    var order = state.receiverOnlyMode ? ["receiver"] : SIGNER_TABS;
    order.forEach(function (key, i) {
      var block = state.blocks[key];
      var pill = document.createElement("div");
      pill.className = "step-pill" + (key === state.activeBlockKey ? " active" : (block.hasStrokes ? " done" : ""));
      pill.style.cursor = state.receiverOnlyMode ? "default" : "pointer";
      var label = key === "receiver" ? "Receiver (approves & signs)" : block.label;
      pill.innerHTML = '<span class="step-num">' + (block.hasStrokes ? "✓" : i + 1) + "</span>" + label;
      if (!state.receiverOnlyMode) pill.addEventListener("click", function () { switchRole(key); });
      el.appendChild(pill);
    });
  }

  function switchRole(key) {
    saveCurrentRoleInputs();
    state.activeBlockKey = key; state.activeReceiverPlacement = "approved";
    var identity = getIdentityBlock();
    renderRoleTabs();
    var receiverIsOptionalHere = key === "receiver" && !state.receiverOnlyMode;
    document.getElementById("nameFieldLabel").textContent = (key === "receiver" ? "Receiver" : identity.label) + " — name" + (receiverIsOptionalHere ? " (optional — receiver fills this in)" : "");
    document.getElementById("roleNameInput").value = identity.nameValue || "";
    document.getElementById("initialsInput").value = key === "receiver" ? (identity.initials || "") : "";
    document.getElementById("roleReceiverExtra").style.display = key === "receiver" ? "" : "none";
    document.getElementById("receiverPrepareNote").style.display = receiverIsOptionalHere ? "" : "none";
    document.getElementById("sigPadLabel").textContent = receiverIsOptionalHere ? "Draw signature (optional — just for previewing placement)" : "Draw signature";
    document.getElementById("placementToggleRow").style.display = key === "receiver" ? "" : "none";
    updatePlacementToggleButtons();
    loadSignatureIntoPad(identity.sigDataUrl);
    updateRoleNextButton();
    syncPositionControlsToBlock();
    renderBigPreview(getPositionBlock().pageIndex);
  }
  function syncPositionControlsToBlock() {
    var block = getPositionBlock();
    document.getElementById("sigSizeSlider").value = String(block.sigBoxW);
    document.getElementById("sigPageSelect").value = String(block.pageIndex);
  }
  function updatePlacementToggleButtons() {
    document.getElementById("placeApprovedBtn").classList.toggle("active", state.activeReceiverPlacement === "approved");
    document.getElementById("placeFinalBtn").classList.toggle("active", state.activeReceiverPlacement === "final");
  }
  document.getElementById("placeApprovedBtn").addEventListener("click", function () { state.activeReceiverPlacement = "approved"; updatePlacementToggleButtons(); syncPositionControlsToBlock(); renderBigPreview(getPositionBlock().pageIndex); });
  document.getElementById("placeFinalBtn").addEventListener("click", function () { state.activeReceiverPlacement = "final"; updatePlacementToggleButtons(); syncPositionControlsToBlock(); renderBigPreview(getPositionBlock().pageIndex); });

  function saveCurrentRoleInputs() {
    var key = state.activeBlockKey; if (!key) return;
    var name = document.getElementById("roleNameInput").value.trim();
    var identity = getIdentityBlock();
    identity.nameValue = name; identity.hasStrokes = sigHasStrokes;
    identity.sigDataUrl = sigHasStrokes ? sigCanvas.toDataURL("image/png") : null;
    if (sigHasStrokes && !identity.signedAt) identity.signedAt = new Date().toISOString();
    if (!sigHasStrokes) identity.signedAt = null;
    if (key === "receiver") {
      identity.initials = document.getElementById("initialsInput").value.trim();
      var approver = state.blocks.approver;
      approver.nameValue = name; approver.hasStrokes = sigHasStrokes; approver.sigDataUrl = identity.sigDataUrl;
      approver.initials = identity.initials; approver.signedAt = identity.signedAt;
    }
  }
  function updateRoleNextButton() {
    var btn = document.getElementById("roleNextBtn");
    // The receiver tab (when not receiverOnlyMode) is only ever visited by
    // choice, to reposition where the receiver's fields will land - it's
    // never a forced stop on the way to sending, so "Next" means the same
    // thing ("go review and send") from either tab.
    btn.textContent = state.receiverOnlyMode ? "Review & complete →" : "Review & send →";
  }
  document.getElementById("roleBackBtn").addEventListener("click", function () {
    saveCurrentRoleInputs();
    if (state.receiverOnlyMode) { showOnly(["modeReceiverIntro"]); return; }
    var idx = SIGNER_TABS.indexOf(state.activeBlockKey);
    if (idx > 0) switchRole(SIGNER_TABS[idx - 1]); else goToStep(2);
  });
  document.getElementById("roleNextBtn").addEventListener("click", function () {
    saveCurrentRoleInputs();
    var identity = getIdentityBlock(); var key = state.activeBlockKey;
    var mustSignNow = key === "preparer" || state.receiverOnlyMode;
    if (mustSignNow && !identity.hasStrokes) { alert('Please draw a signature for "' + (key === "receiver" ? "Receiver" : identity.label) + '" before continuing.'); return; }
    if (state.receiverOnlyMode && !state.blocks.receiver.initials) { alert("Please enter the receiver's initials before continuing."); return; }
    // Preparer flow: signing (or optionally repositioning the receiver's
    // fields) always goes straight to Review & Send from here - it never
    // forces a stop on the other tab first.
    goToStep(4);
  });

  async function renderBigPreview(pageIndex) {
    var page = await state.pdfjsDoc.getPage(pageIndex + 1);
    var vp1 = page.getViewport({ scale: 1 });
    var wrap = document.getElementById("bigPreviewWrap");
    var targetWidth = Math.min(620, wrap.parentElement.clientWidth || 620);
    var scale = targetWidth / vp1.width;
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.getElementById("bigPreviewCanvas");
    canvas.width = viewport.width; canvas.height = viewport.height;
    var ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    state.bigPreviewScale = scale; state.bigPreviewPageWidth = vp1.width; state.bigPreviewPageHeight = vp1.height;
    positionMarkers(); refreshMarkersContent();
  }
  function ptToCssTop(y_pt, h_pt) { return (state.bigPreviewPageHeight - y_pt - h_pt) * state.bigPreviewScale; }
  function ptToCssLeft(x_pt) { return x_pt * state.bigPreviewScale; }
  function positionMarkers() {
    var block = getPositionBlock(); if (!block.sigPos) return;
    var sigEl = document.getElementById("sigMarker");
    sigEl.style.width = (block.sigBoxW * state.bigPreviewScale) + "px"; sigEl.style.height = (block.sigBoxH * state.bigPreviewScale) + "px";
    sigEl.style.left = ptToCssLeft(block.sigPos.x) + "px"; sigEl.style.top = ptToCssTop(block.sigPos.y, block.sigBoxH) + "px";
    var nameEl = document.getElementById("nameMarker");
    nameEl.style.width = (block.nameBoxW * state.bigPreviewScale) + "px"; nameEl.style.height = (block.nameBoxH * state.bigPreviewScale) + "px";
    nameEl.style.left = ptToCssLeft(block.namePos.x) + "px"; nameEl.style.top = ptToCssTop(block.namePos.y, block.nameBoxH) + "px";
    var dateEl = document.getElementById("dateMarker");
    dateEl.style.width = (block.dateBoxW * state.bigPreviewScale) + "px"; dateEl.style.height = (block.dateBoxH * state.bigPreviewScale) + "px";
    dateEl.style.left = ptToCssLeft(block.datePos.x) + "px"; dateEl.style.top = ptToCssTop(block.datePos.y, block.dateBoxH) + "px";
  }
  function refreshMarkersContent() {
    var identity = getIdentityBlock();
    var sigEl = document.getElementById("sigMarker");
    sigEl.innerHTML = sigHasStrokes ? '<img src="' + sigCanvas.toDataURL("image/png") + '" alt="signature preview">' : '<span class="placeholder-label">Draw a signature above, then drag me here</span>';
    document.getElementById("nameMarkerText").textContent = identity.nameValue || (state.activeBlockKey === "receiver" ? "Receiver name" : identity.label + " name");
    document.getElementById("dateMarkerText").textContent = todayDisplay();
  }
  function makeMarkerDraggable(el, posKey, boxWKey, boxHKey) {
    var dragging = false, startPx = null, startPos = null;
    function onDown(e) { dragging = true; var p = e.touches ? e.touches[0] : e; startPx = { x: p.clientX, y: p.clientY }; startPos = { x: getPositionBlock()[posKey].x, y: getPositionBlock()[posKey].y }; e.preventDefault(); }
    function onMove(e) {
      if (!dragging) return;
      var p = e.touches ? e.touches[0] : e;
      var dxPt = (p.clientX - startPx.x) / state.bigPreviewScale, dyPt = (p.clientY - startPx.y) / state.bigPreviewScale;
      var block = getPositionBlock(); var w = block[boxWKey], h = block[boxHKey];
      var newX = Math.max(0, Math.min(startPos.x + dxPt, state.bigPreviewPageWidth - w));
      var newY = Math.max(0, Math.min(startPos.y - dyPt, state.bigPreviewPageHeight - h));
      block[posKey] = { x: newX, y: newY }; positionMarkers(); e.preventDefault();
    }
    function onUp() { dragging = false; }
    el.addEventListener("pointerdown", onDown); window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    el.addEventListener("touchstart", onDown, { passive: false }); window.addEventListener("touchmove", onMove, { passive: false }); window.addEventListener("touchend", onUp);
  }
  makeMarkerDraggable(document.getElementById("sigMarker"), "sigPos", "sigBoxW", "sigBoxH");
  makeMarkerDraggable(document.getElementById("nameMarker"), "namePos", "nameBoxW", "nameBoxH");
  makeMarkerDraggable(document.getElementById("dateMarker"), "datePos", "dateBoxW", "dateBoxH");
  window.addEventListener("resize", function () { if (state.step === 3 && state.pdfjsDoc) renderBigPreview(getPositionBlock().pageIndex); });

  // ---------- signature pad ----------
  var sigCanvas = document.getElementById("sigCanvas");
  var sigCtx = sigCanvas.getContext("2d");
  var sigHasStrokes = false, drawing = false, lastPt = null;
  function sizeSigCanvas() {
    var rect = sigCanvas.getBoundingClientRect(); var dpr = window.devicePixelRatio || 1;
    sigCanvas.width = rect.width * dpr; sigCanvas.height = rect.height * dpr;
    sigCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    loadSignatureIntoPad(getIdentityBlock() ? getIdentityBlock().sigDataUrl : null);
  }
  function clearPadVisual() { sigCtx.save(); sigCtx.setTransform(1, 0, 0, 1, 0, 0); sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); sigCtx.restore(); sigHasStrokes = false; }
  function loadSignatureIntoPad(dataUrl) {
    clearPadVisual();
    if (dataUrl) {
      var img = new Image();
      img.onload = function () {
        var rect = sigCanvas.getBoundingClientRect(); var maxW = rect.width - 20, maxH = rect.height - 40;
        var ratio = Math.min(maxW / img.width, maxH / img.height, 1); var dw = img.width * ratio, dh = img.height * ratio;
        sigCtx.drawImage(img, (rect.width - dw) / 2, rect.height - 30 - dh, dw, dh);
        sigHasStrokes = true; refreshMarkersContent();
      };
      img.src = dataUrl;
    } else refreshMarkersContent();
  }
  function ptFromEvent(e) { var rect = sigCanvas.getBoundingClientRect(); var x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left; var y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top; return { x: x, y: y }; }
  function startDraw(e) { e.preventDefault(); drawing = true; lastPt = ptFromEvent(e); }
  function moveDraw(e) {
    if (!drawing) return; e.preventDefault(); var pt = ptFromEvent(e);
    sigCtx.strokeStyle = "#1c2430"; sigCtx.lineWidth = 2; sigCtx.lineCap = "round"; sigCtx.lineJoin = "round";
    sigCtx.beginPath(); sigCtx.moveTo(lastPt.x, lastPt.y); sigCtx.lineTo(pt.x, pt.y); sigCtx.stroke();
    lastPt = pt; sigHasStrokes = true; refreshMarkersContent();
  }
  function endDraw() { drawing = false; lastPt = null; }
  sigCanvas.addEventListener("pointerdown", startDraw); sigCanvas.addEventListener("pointermove", moveDraw); window.addEventListener("pointerup", endDraw);
  sigCanvas.addEventListener("touchstart", startDraw, { passive: false }); sigCanvas.addEventListener("touchmove", moveDraw, { passive: false }); sigCanvas.addEventListener("touchend", endDraw);
  document.getElementById("clearSig").addEventListener("click", function () { clearPadVisual(); refreshMarkersContent(); });
  window.addEventListener("resize", function () { if (state.step === 3) sizeSigCanvas(); });
  document.getElementById("backTo3").addEventListener("click", function () { goToStep(3); });

  // ---------- STEP 4: review + generate ----------
  function renderCertPreview() {
    saveCurrentRoleInputs();
    var n = state.pageIncluded.filter(Boolean).length;
    var initials = state.blocks.receiver.initials;
    var prep = state.blocks.preparer, recv = state.blocks.receiver, appr = state.blocks.approver;
    var rows = "<div><b>" + escapeHtml(prep.label) + ":</b> " + escapeHtml(prep.nameValue || "(no name entered)") + " — signed, page " + (prep.pageIndex + 1) +
      (prep.sigDataUrl ? '<br><img class="sig-thumb" src="' + prep.sigDataUrl + '">' : "") + "</div>" +
      "<div><b>Receiver (approves &amp; signs):</b> " + (recv.hasStrokes ? escapeHtml(recv.nameValue || "(no name entered)") + " — signed as Approved-by on page " + (appr.pageIndex + 1) + ", and again on page " + (recv.pageIndex + 1) : "will sign as Approved-by on page " + (appr.pageIndex + 1) + ", and again on page " + (recv.pageIndex + 1)) +
      (recv.sigDataUrl ? '<br><img class="sig-thumb" src="' + recv.sigDataUrl + '">' : "") + "</div>";
    document.getElementById("certPreview").innerHTML =
      "<div><b>Document:</b> " + escapeHtml(state.fileName) + " (" + state.pageCount + " pages)</div>" +
      "<div><b>Receiver initials:</b> " + escapeHtml(initials) + " — stamped on " + n + " page" + (n === 1 ? "" : "s") + (state.includePageStamp ? " (with a page/date stamp beside each)" : "") + "</div>" +
      rows + "<div><b>Original file fingerprint (SHA-256):</b><br>" + state.fileHashHex + "</div>";

    var sendBtn = document.getElementById("sendToReceiverBtn"), completeBtn = document.getElementById("completeBtn"),
      completeLocallyLink = document.getElementById("completeLocallyLink"), subtitle = document.getElementById("step4Subtitle"), submitNote = document.getElementById("receiverSubmitNote");
    if (state.receiverOnlyMode) {
      sendBtn.style.display = "none"; completeLocallyLink.style.display = "none"; completeBtn.style.display = "";
      completeBtn.textContent = "Sign & send back to preparer →";
      subtitle.textContent = "This does not finalize the document yet — it goes back to the preparer to lock the final copy.";
      submitNote.style.display = "";
    } else if (session) {
      sendBtn.style.display = ""; completeBtn.style.display = "none"; completeLocallyLink.style.display = "";
      subtitle.textContent = "Once sent, the receiver signs and it comes back to you to finalize and lock.";
      submitNote.style.display = "none";
    } else {
      sendBtn.style.display = "none"; completeLocallyLink.style.display = "none"; completeBtn.style.display = "";
      completeBtn.textContent = "Complete & download PDF";
      subtitle.textContent = "Once you complete this, the initials field is flattened into static text on every page (no longer editable).";
      submitNote.style.display = "none";
    }
  }

  document.getElementById("startOverLink").addEventListener("click", function () {
    state.fileBytes = null; state.fileName = ""; state.fileHashHex = ""; state.pdfjsDoc = null; state.pageCount = 0; state.pageIncluded = [];
    state.preparerEmail = null; state.receiverEmail = null; state.currentDocId = null;
    state.blocks = { preparer: blankBlock("Prepared by"), approver: blankBlock("Approved by (Receiver)"), receiver: blankBlock("Receiver") };
    state.activeBlockKey = "preparer"; state.activeReceiverPlacement = "approved"; state.receiverOnlyMode = false;
    fileInput.value = "";
    document.getElementById("receiverEmailInput").value = ""; document.getElementById("preparerEmailInput").value = "";
    setStatus("genStatus", "", "");
    if (urlDocId()) { var url = new URL(window.location.href); url.searchParams.delete("id"); history.replaceState(null, "", url.toString()); }
    goToStep(1);
  });

  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
  }

  document.getElementById("completeLocallyLink").addEventListener("click", function () {
    if (!state.blocks.receiver.hasStrokes) {
      var proceed = confirm("The receiver hasn't signed yet (you skipped that while preparing to send). Completing it now will produce a PDF with the receiver's parts left blank. Continue anyway?");
      if (!proceed) return;
    }
    finishAndDownload({ sendMode: false });
  });
  document.getElementById("completeBtn").addEventListener("click", function () {
    if (state.receiverOnlyMode) return submitReceiverSigning();
    return finishAndDownload({ sendMode: false });
  });
  document.getElementById("sendToReceiverBtn").addEventListener("click", function () { finishAndDownload({ sendMode: true }); });

  async function finishAndDownload(opts) {
    var sendMode = opts.sendMode;
    var sendBtn = document.getElementById("sendToReceiverBtn"), completeBtn = document.getElementById("completeBtn");
    var activeBtn = sendMode ? sendBtn : completeBtn;
    activeBtn.disabled = true;
    try {
      if (sendMode) { await sendToReceiver(); return; }
      setStatus("genStatus", "Generating signed PDF…");
      var bytes = await buildSignedPdf();
      var baseName = state.fileName.replace(/\.pdf$/i, "");
      downloadBlob(baseName + "_signed.pdf", new Blob([bytes], { type: "application/pdf" }));
      setStatus("genStatus", "Saved ✓", "ok");
    } catch (err) {
      console.error(err);
      setStatus("genStatus", "Something went wrong generating the PDF: " + (err.message || err), "err");
    } finally { activeBtn.disabled = false; }
  }

  async function sendToReceiver() {
    setStatus("genStatus", "Uploading the prepared document…");
    saveCurrentRoleInputs();
    var receiverEmail = document.getElementById("receiverEmailInput").value.trim();
    var preparerEmail = document.getElementById("preparerEmailInput").value.trim();
    try {
      var blobUrl = await uploadFileToBackend(new Blob([state.fileBytes], { type: "application/pdf" }), state.fileName);
      var payload = {
        fileName: state.fileName, pageCount: state.pageCount, fileHashHex: state.fileHashHex,
        originalBlobUrl: blobUrl, pageIncluded: state.pageIncluded, includePageStamp: state.includePageStamp,
        blocks: state.blocks, receiverEmail: receiverEmail, preparerEmail: preparerEmail
      };
      payload.action = "create";
      var result = await apiPost("/api/esign", payload);
      state.currentDocId = result.id;
      setStatus("genStatus", result.emailSent
        ? "Sent ✓ — the receiver has been emailed."
        : "Sent ✓ — but the automatic email didn't go out (" + (result.emailReason || "unknown reason") + "). Use the copy box below.",
        result.emailSent ? "ok" : "");
      history.replaceState(null, "", docLinkFor(state.currentDocId));
      showAwaitingOwnerMode({ fileName: state.fileName, pageCount: state.pageCount, pageIncluded: state.pageIncluded, receiverEmail: receiverEmail }, result.emailSent, result.emailReason);
    } catch (err) {
      console.error(err);
      setStatus("genStatus", "Something went wrong sending the document: " + (err.message || err), "err");
    }
  }

  function describeEmailFailure(reason) {
    var known = { "no-address": "no email address was entered", "not_configured": "email sending isn't configured on this deployment" };
    return known[reason] || (reason || "automatic sending isn't available here");
  }

  function renderEmailFallback(containerId, to, subject, body, emailStatus, failReason) {
    var container = document.getElementById(containerId);
    if (!to) { container.style.display = "none"; container.innerHTML = ""; return; }
    var fullText = "To: " + to + "\nSubject: " + subject + "\n\n" + body;
    var banner = "";
    if (emailStatus === "failed") banner = '<div class="ef-hint" style="color:var(--danger);font-weight:600;">⚠️ Automatic email didn\'t go out — ' + escapeHtml(describeEmailFailure(failReason)) + ".</div>";
    else if (emailStatus === "sent") banner = '<div class="ef-hint" style="font-weight:600;">A real, server-sent email was also delivered via Resend to this address.</div>';
    container.innerHTML =
      '<div class="email-fallback">' + banner +
      '<div class="ef-hint">Copy this and paste it into your own email if you need a manual backup:</div>' +
      '<textarea readonly id="' + containerId + '_ta"></textarea>' +
      '<div class="ef-actions"><button type="button" class="btn btn-ghost" id="' + containerId + '_copy">Copy</button></div></div>';
    container.querySelector("textarea").value = fullText;
    container.style.display = "";
    container.querySelector("button").addEventListener("click", async function (e) {
      var btn = e.currentTarget;
      try { await navigator.clipboard.writeText(fullText); btn.textContent = "Copied ✓"; }
      catch (err) { container.querySelector("textarea").select(); btn.textContent = "Select all above and copy"; }
      setTimeout(function () { btn.textContent = "Copy"; }, 2500);
    });
  }

  function showEmailLinkButton(containerPrefix, email, fileName, emailSent, failReason) {
    var row = document.getElementById(containerPrefix + "EmailRow");
    var btn = document.getElementById(containerPrefix + "EmailBtn");
    var link = docLinkFor(state.currentDocId);
    var subjectText = "Please sign: " + fileName;
    var bodyText = "Hi,\n\nPlease review and sign the document: " + fileName + ".\n\nOpen this link to sign it:\n" + link + "\n\nThanks!";
    if (btn) btn.href = "mailto:" + encodeURIComponent(email || "") + "?subject=" + encodeURIComponent(subjectText) + "&body=" + encodeURIComponent(bodyText);
    if (row) row.style.display = email ? "" : "none";
    renderEmailFallback(containerPrefix + "EmailFallback", email, subjectText, bodyText, emailSent ? "sent" : (failReason ? "failed" : null), failReason);
  }

  async function submitReceiverSigning() {
    var btn = document.getElementById("completeBtn"); btn.disabled = true;
    setStatus("genStatus", "Sending your signature back to the preparer…");
    try {
      saveCurrentRoleInputs();
      var rBlock = state.blocks.receiver;
      var result = await apiPost("/api/esign", { action: "submit", id: state.currentDocId, receiver: rBlock });
      setStatus("genStatus", "", "");
      showReceiverSubmittedMode(rBlock, result.emailSent, result.emailReason);
    } catch (err) {
      console.error(err);
      setStatus("genStatus", "Something went wrong sending this back: " + (err.message || err), "err");
    } finally { btn.disabled = false; }
  }

  function showReceiverSubmittedMode(rBlock, emailSent, emailFailReason) {
    showOnly(["modeReceiverSubmitted"]);
    document.getElementById("receiverSubmittedSummary").innerHTML =
      "Thanks" + (rBlock.nameValue ? ", " + escapeHtml(rBlock.nameValue) : "") + " — your initials, approval and signature have been sent back.<br>" +
      "The preparer will review and lock the final copy, then get it back to you." +
      (emailSent ? "<br>The preparer has been notified by email." : "");
    if (state.preparerEmail) showEmailLinkButton("receiverSubmitted", state.preparerEmail, state.fileName, emailSent, emailFailReason);
    else { document.getElementById("receiverSubmittedEmailRow").style.display = "none"; renderEmailFallback("receiverSubmittedEmailFallback", null, "", ""); }
  }

  function showAwaitingOwnerMode(data, emailAlreadySent, emailFailReason) {
    showOnly(["modeAwaiting"]);
    var n = (data.pageIncluded || []).filter(Boolean).length;
    document.getElementById("awaitingSummary").innerHTML =
      "<b>" + escapeHtml(data.fileName) + "</b> (" + data.pageCount + " pages) is prepared and waiting for the receiver to sign.<br>" +
      "Initials will land on " + n + " page" + (n === 1 ? "" : "s") + ". Share this exact page's link with them — they'll see the signing view when they open it." +
      (data.receiverEmail ? "<br>Prepared for: " + escapeHtml(data.receiverEmail) + (emailAlreadySent ? " (emailed ✓)" : "") : "");
    showEmailLinkButton("awaiting", data.receiverEmail, data.fileName, emailAlreadySent, emailFailReason);
    var emailBtn = document.getElementById("awaitingEmailBtn");
    emailBtn.textContent = emailAlreadySent ? "✉️ Resend the email manually" : "✉️ Open email to send this link";
  }

  async function showCompletedMode(data, isOwner, emailAlreadySent, emailFailReason) {
    showOnly(["modeCompleted"]);
    var r = data.blocks && data.blocks.receiver;
    document.getElementById("completedSummary").innerHTML =
      "<div><b>Document:</b> " + escapeHtml(data.fileName) + " (" + data.pageCount + " pages)</div>" +
      "<div><b>Receiver:</b> " + escapeHtml((r && r.nameValue) || "(no name)") + " — initials " + escapeHtml((r && r.initials) || "") + (data.receiverEmail ? " · " + escapeHtml(data.receiverEmail) : "") + (emailAlreadySent ? " (emailed ✓)" : "") + "</div>" +
      "<div><b>Completed:</b> " + (data.completedAt ? new Date(data.completedAt).toString() : "(unknown time)") + "</div>" +
      "<div><b>Original file fingerprint (SHA-256):</b><br>" + data.fileHashHex + "</div>";
    document.getElementById("completedStartOverBtn").style.display = isOwner ? "" : "none";
    if (isOwner && data.receiverEmail) {
      document.getElementById("completedEmailBtn").textContent = emailAlreadySent ? "✉️ Resend the email manually" : "✉️ Email the receiver their copy";
      showEmailLinkButton("completed", data.receiverEmail, data.fileName, emailAlreadySent, emailFailReason);
    } else {
      document.getElementById("completedEmailRow").style.display = "none";
      renderEmailFallback("completedEmailFallback", null, "", "");
    }
    setStatus("completedStatus", "", "");
    var dlBtn = document.getElementById("completedDownloadBtn");
    dlBtn.onclick = async function () {
      dlBtn.disabled = true; setStatus("completedStatus", "Fetching the final copy…");
      try {
        var url = data.finalBlobUrl;
        var resp = await fetch(url); if (!resp.ok) throw new Error("HTTP " + resp.status);
        var bytes = await resp.arrayBuffer();
        downloadBlob(data.fileName.replace(/\.pdf$/i, "") + "_signed.pdf", new Blob([bytes], { type: "application/pdf" }));
        setStatus("completedStatus", "Saved ✓", "ok");
      } catch (e) { setStatus("completedStatus", "Couldn't fetch the final PDF: " + (e.message || e), "err"); }
      finally { dlBtn.disabled = false; }
    };
  }

  // ---------- PDF generation (unchanged from the tested prototype) ----------
  async function buildSignedPdf() {
    var PDFDocument = PDFLib.PDFDocument, rgb = PDFLib.rgb, StandardFonts = PDFLib.StandardFonts;
    var pdfDoc = await PDFDocument.load(state.fileBytes.slice());
    var font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    var boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    var pages = pdfDoc.getPages();
    var totalPages = pages.length;
    var initials = state.blocks.receiver.initials || "";
    var form = pdfDoc.getForm();
    var targetPages = [];
    pages.forEach(function (p, idx) { if (state.pageIncluded[idx]) targetPages.push({ page: p, num: idx + 1 }); });

    if (targetPages.length > 0) {
      var field = form.createTextField("receiver_initials");
      field.setText(initials);
      targetPages.forEach(function (tp) {
        var page = tp.page, num = tp.num;
        var w = page.getWidth(), h = page.getHeight();
        var x2 = w - MARGIN_RIGHT, x1 = x2 - BOX_W, y1 = MARGIN_BOTTOM;
        field.addToPage(page, { x: x1, y: y1, width: BOX_W, height: BOX_H, font: font, textColor: rgb(0.1, 0.1, 0.15), backgroundColor: rgb(0.98, 0.94, 0.8), borderColor: rgb(0.7, 0.55, 0.05), borderWidth: 1 });
        if (state.includePageStamp) {
          var stampDate = blockSignedDate(state.blocks.receiver);
          var stampText = "Pg " + num + "/" + totalPages + " · " + stampDate;
          var stampSize = 7; var stampWidth = font.widthOfTextAtSize(stampText, stampSize);
          page.drawText(stampText, { x: x1 - 8 - stampWidth, y: y1 + 3, size: stampSize, font: font, color: rgb(0.35, 0.35, 0.4) });
        }
      });
      field.setFontSize(8); form.updateFieldAppearances(font); form.flatten();
    }

    for (var k = 0; k < PLACEMENT_KEYS.length; k++) {
      var key = PLACEMENT_KEYS[k]; var block = state.blocks[key];
      if (!block.sigDataUrl || !block.sigPos) continue;
      var targetPage = pages[block.pageIndex];
      var pngBytes = dataUrlToBytes(block.sigDataUrl);
      var pngImage = await pdfDoc.embedPng(pngBytes);
      var ratio = Math.min(block.sigBoxW / pngImage.width, block.sigBoxH / pngImage.height);
      var dw = pngImage.width * ratio, dh = pngImage.height * ratio;
      var dx = block.sigPos.x + (block.sigBoxW - dw) / 2, dy = block.sigPos.y + (block.sigBoxH - dh) / 2;
      targetPage.drawImage(pngImage, { x: dx, y: dy, width: dw, height: dh });
      if (block.nameValue && block.namePos) targetPage.drawText(block.nameValue, { x: block.namePos.x, y: block.namePos.y + 2, size: 10, font: font, color: rgb(0.1, 0.1, 0.15) });
      if (block.datePos) targetPage.drawText(blockSignedDate(block), { x: block.datePos.x, y: block.datePos.y + 2, size: 9, font: font, color: rgb(0.1, 0.1, 0.15) });
    }

    var certPage = pdfDoc.addPage([612, 792]);
    var y = 740, left = 56;
    certPage.drawText("Signature & Completion Certificate", { x: left, y: y, size: 16, font: boldFont }); y -= 30;
    certPage.drawText("Generated by Docket's e-signature module.", { x: left, y: y, size: 10, font: font, color: rgb(0.4, 0.4, 0.45) }); y -= 34;

    var prepBlock = state.blocks.preparer, recvBlock = state.blocks.receiver;
    var fmtBoth = function (iso) { return iso ? new Date(iso).toString() + "  (UTC: " + new Date(iso).toISOString() + ")" : "(not recorded)"; };
    var headerLines = [
      ["Document", state.fileName], ["Pages", String(state.pageCount)],
      ["Receiver initials", initials + "  (on " + targetPages.length + " page" + (targetPages.length === 1 ? "" : "s") + ")"],
      ["Prepared & signed", fmtBoth(prepBlock.signedAt)], ["Approved & signed by receiver", fmtBoth(recvBlock.signedAt)],
      ["Finalized & locked by preparer", fmtBoth(new Date().toISOString())],
      ["Completion ID", (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))],
      ["Original file SHA-256", state.fileHashHex]
    ];
    headerLines.forEach(function (pair) {
      var label = pair[0], value = pair[1];
      certPage.drawText(label + ":", { x: left, y: y, size: 10, font: boldFont });
      var wrapped = wrapText(value, 60);
      wrapped.forEach(function (line, i) { certPage.drawText(line, { x: left + 190, y: y - i * 13, size: 10, font: font, color: rgb(0.15, 0.15, 0.2) }); });
      y -= 13 * Math.max(1, wrapped.length) + 10;
    });

    y -= 6;
    for (var s = 0; s < SIGNER_TABS.length; s++) {
      var skey = SIGNER_TABS[s]; var sblock = state.blocks[skey];
      if (y < 130) break;
      var heading = skey === "receiver" ? "Receiver (approves & signs)" : sblock.label;
      var pageNote = skey === "receiver" ? "Signed as Approved-by on page " + (state.blocks.approver.pageIndex + 1) + ", and again on page " + (sblock.pageIndex + 1) : "Signed on page " + (sblock.pageIndex + 1);
      certPage.drawText(heading + ":", { x: left, y: y, size: 11, font: boldFont }); y -= 15;
      certPage.drawText("Name: " + (sblock.nameValue || "(not provided)") + "   ·   " + pageNote, { x: left, y: y, size: 9.5, font: font, color: rgb(0.2, 0.2, 0.25) }); y -= 8;
      if (sblock.sigDataUrl) {
        var pb = dataUrlToBytes(sblock.sigDataUrl); var pi = await pdfDoc.embedPng(pb);
        var maxW = 150, maxH = 42; var r2 = Math.min(maxW / pi.width, maxH / pi.height);
        var dw2 = pi.width * r2, dh2 = pi.height * r2;
        certPage.drawImage(pi, { x: left, y: y - dh2, width: dw2, height: dh2 }); y -= dh2 + 6;
      }
      certPage.drawLine({ start: { x: left, y: y + 4 }, end: { x: left + 220, y: y + 4 }, thickness: 0.6, color: rgb(0.75, 0.75, 0.8) }); y -= 20;
    }
    return await pdfDoc.save();
  }

  function wrapText(text, maxChars) {
    if (text.length <= maxChars) return [text];
    var words = text.split(" "); var lines = [], cur = "";
    words.forEach(function (w) { if (cur && (cur + " " + w).trim().length > maxChars) { lines.push(cur.trim()); cur = w; } else cur = (cur + " " + w).trim(); });
    if (cur) lines.push(cur);
    return lines;
  }
  function dataUrlToBytes(dataUrl) {
    var base64 = dataUrl.split(",")[1]; var binStr = atob(base64); var bytes = new Uint8Array(binStr.length);
    for (var i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    return bytes;
  }

  // ---------- Handoff modes ----------
  async function fetchAssetBytes(url) { var resp = await fetch(url); if (!resp.ok) throw new Error("Could not load the prepared document (HTTP " + resp.status + ")."); return await resp.arrayBuffer(); }
  function docStatusBadge(status) {
    if (status === "awaiting_receiver") return { cls: "awaiting", label: "Awaiting receiver" };
    if (status === "receiver_signed") return { cls: "signed", label: "Ready to finalize" };
    if (status === "completed") return { cls: "completed", label: "Completed" };
    return { cls: "", label: status || "" };
  }

  async function showDashboard(notFound) {
    showOnly(["modeDashboard"]);
    var sub = document.querySelector("#modeDashboard .sub");
    sub.textContent = notFound ? "That document link wasn't found — it may have been cancelled." : "Documents you've prepared or sent, most recent first.";
    setStatus("dashboardStatus", "Loading…");
    var list = document.getElementById("dashboardList"); list.innerHTML = "";
    try {
      var res = await apiGet("/api/esign?action=list");
      setStatus("dashboardStatus", "", "");
      if (!res.documents.length) { list.innerHTML = '<div class="doc-empty">No documents yet — prepare your first one below.</div>'; return; }
      res.documents.forEach(function (d) {
        var badge = docStatusBadge(d.status);
        var row = document.createElement("div"); row.className = "doc-row";
        row.innerHTML =
          '<div class="doc-icon">📄</div><div class="doc-main"><div class="doc-name">' + escapeHtml(d.fileName || "Untitled") + '</div>' +
          '<div class="doc-meta">' + (d.receiverEmail ? escapeHtml(d.receiverEmail) : "") + (d.createdAt ? " · " + new Date(d.createdAt).toLocaleDateString() : "") + "</div></div>" +
          '<span class="doc-badge ' + badge.cls + '">' + badge.label + "</span>";
        row.addEventListener("click", function () { window.location.href = docLinkFor(d.id); });
        list.appendChild(row);
      });
    } catch (err) { console.error(err); setStatus("dashboardStatus", "Couldn't load your documents: " + (err.message || err), "err"); }
  }
  document.getElementById("dashboardNewBtn").addEventListener("click", function () { document.getElementById("startOverLink").click(); });
  document.getElementById("allDocsLink").addEventListener("click", function () { goToDashboard(); });

  function showReviewFinalizeMode(data) {
    showOnly(["modeReviewFinalize"]);
    var r = data.blocks && data.blocks.receiver;
    document.getElementById("reviewFinalizeSummary").innerHTML =
      "<div><b>Document:</b> " + escapeHtml(data.fileName) + " (" + data.pageCount + " pages)</div>" +
      "<div><b>Receiver:</b> " + escapeHtml((r && r.nameValue) || "(no name)") + " — initials " + escapeHtml((r && r.initials) || "") + (data.receiverEmail ? " · " + escapeHtml(data.receiverEmail) : "") + "</div>" +
      "<div><b>Signed back:</b> " + (data.receiverSignedAt ? new Date(data.receiverSignedAt).toString() : "(unknown time)") + "</div>" +
      (r && r.sigDataUrl ? '<div><b>Signature:</b><br><img class="sig-thumb" src="' + r.sigDataUrl + '"></div>' : "");
    setStatus("finalizeStatus", "", "");
  }

  document.getElementById("finalizeBtn").addEventListener("click", async function () {
    var btn = document.getElementById("finalizeBtn"); btn.disabled = true;
    setStatus("finalizeStatus", "Building the final locked copy…");
    try {
      var data = await apiGet("/api/esign?id=" + encodeURIComponent(state.currentDocId));
      var bytes = await fetchAssetBytes(data.originalBlobUrl);
      await loadPreparedDocumentIntoState(data, bytes);
      var finalBytes = await buildSignedPdf();
      setStatus("finalizeStatus", "Uploading the final copy…");
      var finalUrl = await uploadFileToBackend(new Blob([finalBytes], { type: "application/pdf" }), state.fileName);
      var result = await apiPost("/api/esign", { action: "finalize", id: state.currentDocId, finalBlobUrl: finalUrl });
      var merged = Object.assign({}, data, { status: "completed", finalBlobUrl: finalUrl, completedAt: new Date().toISOString() });
      setStatus("finalizeStatus", result.emailSent ? "Finalized ✓ — receiver notified by email." : "Finalized ✓ — but the automatic email didn't go out (" + (result.emailReason || "unknown reason") + "). Use the copy box below.", "ok");
      await showCompletedMode(merged, true, result.emailSent, result.emailReason);
    } catch (err) {
      console.error(err);
      setStatus("finalizeStatus", "Couldn't finalize: " + (err.message || err), "err");
    } finally { btn.disabled = false; }
  });

  async function loadPreparedDocumentIntoState(data, arrayBuf) {
    state.fileBytes = new Uint8Array(arrayBuf);
    state.fileName = data.fileName; state.fileHashHex = data.fileHashHex;
    var pdfjs = await ensurePdfjs();
    var loadingTask = pdfjs.getDocument({ data: state.fileBytes.slice() });
    state.pdfjsDoc = await loadingTask.promise;
    state.pageCount = state.pdfjsDoc.numPages;
    state.pageIncluded = data.pageIncluded && data.pageIncluded.length === state.pageCount ? data.pageIncluded.slice() : new Array(state.pageCount).fill(true);
    state.includePageStamp = data.includePageStamp !== false;
    state.preparerEmail = data.preparerEmail || null; state.receiverEmail = data.receiverEmail || null;
    state.blocks = {
      preparer: Object.assign(blankBlock("Prepared by"), data.blocks.preparer),
      approver: Object.assign(blankBlock("Approved by (Receiver)"), data.blocks.approver),
      receiver: Object.assign(blankBlock("Receiver"), data.blocks.receiver)
    };
    var select = document.getElementById("sigPageSelect"); select.innerHTML = "";
    for (var i = 1; i <= state.pageCount; i++) { var opt = document.createElement("option"); opt.value = i - 1; opt.textContent = "Page " + i; select.appendChild(opt); }
    document.getElementById("todayDisplaySpan").textContent = todayDisplay();
  }

  async function enterReceiverMode(data) {
    showOnly(["modeReceiverIntro"]);
    setStatus("receiverLoadStatus", "Loading the prepared document…");
    try {
      var bytes = await fetchAssetBytes(data.originalBlobUrl);
      await loadPreparedDocumentIntoState(data, bytes);
      state.receiverOnlyMode = true; state.activeBlockKey = "receiver";
      var p = data.blocks.preparer, a = data.blocks.approver;
      document.getElementById("receiverIntroSummary").innerHTML =
        "<b>" + escapeHtml(data.fileName) + "</b> (" + data.pageCount + " pages)" +
        (p && p.nameValue ? "<br>Prepared by " + escapeHtml(p.nameValue) : "") + (a && a.nameValue ? " · Approved by " + escapeHtml(a.nameValue) : "") +
        "<br>You'll add your initials on " + state.pageIncluded.filter(Boolean).length + " page(s) and sign once.";
      setStatus("receiverLoadStatus", "", "");
      document.getElementById("receiverBeginBtn").disabled = false;
    } catch (err) { console.error(err); setStatus("receiverLoadStatus", "Couldn't load the document: " + (err.message || err), "err"); }
  }
  document.getElementById("receiverBeginBtn").addEventListener("click", function () {
    document.getElementById("roleReceiverExtra").style.display = "";
    state.step = 3; showOnly(["step3"]); switchRole("receiver");
  });

  document.getElementById("awaitingCancelBtn").addEventListener("click", async function () {
    if (!confirm("Cancel this document and start over? The receiver's link will stop working.")) return;
    try { await apiPost("/api/esign", { action: "cancel", id: state.currentDocId }); } catch (e) { console.error(e); }
    goToDashboard();
  });
  document.getElementById("finalizeCancelBtn").addEventListener("click", async function () {
    if (!confirm("Cancel this document and start over? The receiver's signing will be discarded.")) return;
    try { await apiPost("/api/esign", { action: "cancel", id: state.currentDocId }); } catch (e) { console.error(e); }
    goToDashboard();
  });
  document.getElementById("completedStartOverBtn").addEventListener("click", function () { document.getElementById("startOverLink").click(); });
  document.getElementById("awaitingEditBtn").addEventListener("click", async function () {
    setStatus("genStatus", "", "");
    try {
      var data = await apiGet("/api/esign?id=" + encodeURIComponent(state.currentDocId));
      var bytes = await fetchAssetBytes(data.originalBlobUrl);
      await loadPreparedDocumentIntoState(data, bytes);
      document.getElementById("receiverEmailInput").value = data.receiverEmail || "";
      document.getElementById("preparerEmailInput").value = data.preparerEmail || "";
      state.receiverOnlyMode = false;
      await buildPageGrid();
      goToStep(2);
    } catch (err) { console.error(err); alert("Couldn't load the prepared document for editing: " + (err.message || err)); }
  });

  // ---------- boot ----------
  async function bootApp() {
    renderStepPills();
    var sigObserver = new MutationObserver(function () { if (document.getElementById("step3").style.display !== "none") sizeSigCanvas(); });
    sigObserver.observe(document.getElementById("step3"), { attributes: true, attributeFilter: ["style"] });

    await loadSession();

    var id = urlDocId();
    if (!id) {
      if (!session) { showOnly(["modeLoggedOut"]); return; }
      await showDashboard();
      return;
    }
    state.currentDocId = id;
    try {
      var data = await apiGet("/api/esign?id=" + encodeURIComponent(id));
      var isOwner = !!session;
      if (data.status === "awaiting_receiver") {
        if (isOwner) showAwaitingOwnerMode(data);
        else await enterReceiverMode(data);
      } else if (data.status === "receiver_signed") {
        if (isOwner) showReviewFinalizeMode(data);
        else {
          state.fileName = data.fileName; state.preparerEmail = data.preparerEmail || null;
          showReceiverSubmittedMode(data.blocks.receiver);
        }
      } else if (data.status === "completed") {
        await showCompletedMode(data, isOwner);
      }
    } catch (err) {
      console.error("Could not load document:", err);
      if (session) await showDashboard(true);
      else { showOnly([]); document.querySelector(".wrap").insertAdjacentHTML("afterbegin", '<div class="card"><h2>Not found</h2><p class="sub">That signing link is invalid, was cancelled, or has expired.</p></div>'); }
    }
  }

  bootApp();
})();
