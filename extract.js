// Docket document extraction — reads a dropped PDF/DOCX/TXT entirely in the browser
// (pdf.js / JSZip, both loaded from CDN) and applies pattern-matching heuristics to
// guess a handful of objective fields (dates, value, currency, title, counterparty,
// governing law). Nothing is sent anywhere; this never calls an API and makes no
// judgment calls about risk, obligations, or clauses — those still need a human read.
(function (global) {
  "use strict";

  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  function pad2(n) { return String(n).padStart(2, "0"); }
  function toISO(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 0 || m > 11 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, m, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
    return y + "-" + pad2(m + 1) + "-" + pad2(d);
  }
  function addMonthsISO(iso, months) {
    var p = iso.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  }

  // Many contracts state a DURATION ("for a term of three (3) years") rather than an
  // explicit expiry date. Requires the word "term" nearby, so a stray "5 years" in an
  // unrelated clause (e.g. a 5-year-old building, a penalty period) isn't mistaken for
  // the contract's own length.
  var TERM_KEYWORD_RE = /\bterm\b/gi;
  var DURATION_RE = /\(?(\d{1,3})\)?\s*(year|month)s?\b/gi;

  function findTermMonths(text) {
    var termPositions = [];
    var tm;
    TERM_KEYWORD_RE.lastIndex = 0;
    while ((tm = TERM_KEYWORD_RE.exec(text)) !== null) termPositions.push(tm.index);
    if (!termPositions.length) return null;

    var best = null, bestDist = Infinity, bestValue = null, bestUnit = null;
    var dm;
    DURATION_RE.lastIndex = 0;
    while ((dm = DURATION_RE.exec(text)) !== null) {
      var n = Number(dm[1]);
      if (!n || n > 100) continue; // guard against stray large numbers (e.g. a year like "2026")
      var isYears = /year/i.test(dm[2]);
      var months = isYears ? n * 12 : n;
      termPositions.forEach(function (ti) {
        var dist = Math.abs(dm.index - ti);
        if (dist <= 80 && dist < bestDist) { bestDist = dist; best = months; bestValue = n; bestUnit = isYears ? "Years" : "Months"; }
      });
    }
    // Keeps the originally-stated figure (e.g. "3 years") alongside the
    // computed month count, so a caller can show the reader what was
    // actually found in the text, not just the derived expiry date.
    return best ? { months: best, value: bestValue, unit: bestUnit } : null;
  }

  // Matches: "11 June 2026", "11th June 2026", "June 11, 2026", "2026-06-11", "11/06/2026"
  var DATE_PATTERNS = [
    { re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i,
      toDate: function (m) { return toISO(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]); } },
    { re: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
      toDate: function (m) { return toISO(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]); } },
    { re: /\b(\d{4})-(\d{2})-(\d{2})\b/,
      toDate: function (m) { return toISO(+m[1], +m[2] - 1, +m[3]); } },
    { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
      // Ambiguous DD/MM vs MM/DD - assume DD/MM (most of this app's target locales do), fall back to MM/DD if DD>12.
      toDate: function (m) {
        var a = +m[1], b = +m[2], y = +m[3];
        if (a <= 12 && b > 12) return toISO(y, a - 1, b); // looks like MM/DD after all
        return toISO(y, b - 1, a);
      } }
  ];

  function findAllDates(text) {
    var found = [];
    DATE_PATTERNS.forEach(function (p) {
      var re = new RegExp(p.re.source, p.re.flags.indexOf("g") === -1 ? p.re.flags + "g" : p.re.flags);
      var m;
      while ((m = re.exec(text)) !== null) {
        var iso = p.toDate(m);
        if (iso) found.push({ index: m.index, iso: iso, raw: m[0] });
      }
    });
    return found.sort(function (a, b) { return a.index - b.index; });
  }

  var START_KEYWORDS = /(effective date|commencement date|start date|commences? on|shall commence|dated)/i;
  var EXPIRY_KEYWORDS = /(expiry date|expiration date|end date|expir(?:es?|ing)(?:\s+on)?|terminat(?:es?|ing)(?:\s+on)?|termination date)/i;

  function keywordProximityDate(text, dates, keywordRe, windowChars) {
    var best = null, bestDist = Infinity;
    var re = new RegExp(keywordRe.source, "gi");
    var km;
    while ((km = re.exec(text)) !== null) {
      var kmEnd = km.index + km[0].length;
      dates.forEach(function (d) {
        // A date can sit either before its label ("Date: 11 June 2026 (the "Effective
        // Date")") or after it ("Effective Date: 11 June 2026") - real contracts use
        // both, so check whichever side is closer rather than only looking forward.
        var distAfter = d.index - kmEnd;
        var distBefore = km.index - (d.index + d.raw.length);
        var dist = distAfter >= 0 ? distAfter : (distBefore >= 0 ? distBefore : Infinity);
        if (dist <= windowChars && dist < bestDist) { bestDist = dist; best = d; }
      });
    }
    return best;
  }

  var CURRENCY_MAP = { "S$": "SGD", "US$": "USD", "RM": "MYR", "$": "USD", "€": "EUR", "£": "GBP", "¥": "CNY" };
  var CURRENCY_CODES = ["SGD", "USD", "MYR", "CNY", "EUR", "HKD", "GBP", "IDR", "THB", "VND"];

  function findMoney(text) {
    // Real contracts often write both the code and a symbol together ("SGD $15,000"),
    // so the symbol between a matched code and the number is optional, not absent.
    var codePattern = "(" + CURRENCY_CODES.join("|") + ")\\s?(?:S\\$|US\\$|RM|\\$|€|£|¥)?\\s?([\\d,]{2,}(?:\\.\\d+)?)";
    var symbolPattern = "(S\\$|US\\$|RM|\\$|€|£|¥)\\s?([\\d,]{2,}(?:\\.\\d+)?)";
    var re = new RegExp(codePattern + "|" + symbolPattern, "g");
    // A bare "$" is genuinely ambiguous (SGD/USD/HKD/etc all use it). Default it to
    // USD only when nothing in the document suggests otherwise; if "SGD"/"S$"/
    // "Singapore" appears anywhere, a bare "$" elsewhere is far more likely SGD too -
    // a contract almost never mixes dollar currencies without spelling out which is which.
    var impliedBareDollar = /\bSGD\b|S\$|\bSingapore\b/i.test(text) ? "SGD" : "USD";
    var best = null;
    var m;
    while ((m = re.exec(text)) !== null) {
      var currency = m[1] || (m[3] === "$" ? impliedBareDollar : CURRENCY_MAP[m[3]]) || null;
      var raw = m[2] || m[4];
      if (!currency || !raw) continue;
      var value = Number(raw.replace(/,/g, ""));
      if (isNaN(value) || value <= 0) continue;
      if (!best || value > best.value) best = { value: value, currency: currency };
    }
    return best;
  }

  // A company name is a run of consecutive Title-Case tokens (allowing parenthetical
  // asides like "(Singapore)") ending in a known suffix. Built as "find runs of
  // capitalized words, then check the tail" rather than one greedy character class,
  // because a permissive class happily swallows leading lowercase filler ("Date of
  // 11 June 2026 by and between Global Air Cargo... Pte Ltd") whenever the real text
  // has no line break to stop it at - and PDF-extracted text often doesn't.
  // Anchored on the suffix word itself, then walks BACKWARD through consecutive
  // capitalized words to find where the company name starts. This is more robust
  // than matching forward from an arbitrary start and checking the tail: a forward
  // greedy match can swallow an unrelated Title Case heading before the real name
  // ("STRATEGIC PARTNERSHIP AGREEMENT Between Kingston ... Pte Ltd") and still pass
  // a tail check, since the tail check only looks at the end of whatever it grabbed.
  var SUFFIX_WORDS = { "ltd": 1, "bhd": 1, "inc": 1, "llc": 1, "limited": 1, "berhad": 1,
    "company": 1, "plc": 1, "corp": 1, "corporation": 1 };
  // Words that are frequently capitalized (sentence starts, ALL-CAPS headings, party
  // labels) but are never themselves part of a company's proper name - without this,
  // the backward walk happily annexes "PARTY A", "SERVICES AGREEMENT", "Between", etc.
  var COMPANY_STOPWORDS = { "and": 1, "between": 1, "this": 1, "agreement": 1, "party": 1,
    "parties": 1, "the": 1, "for": 1, "of": 1, "by": 1, "dated": 1, "date": 1, "term": 1,
    "witness": 1, "whereof": 1, "hereinafter": 1, "referred": 1, "to": 1, "as": 1,
    "services": 1, "a": 1, "b": 1 };

  function cleanWord(w) {
    return w.replace(/^[(\["'’“]+/, "").replace(/[)\]"'’”,.;:!?]+$/, "");
  }

  function findCompanies(text, limit) {
    var words = text.match(/\S+/g) || [];
    var seen = {};
    var out = [];
    for (var i = 0; i < words.length && out.length < limit; i++) {
      if (!SUFFIX_WORDS[cleanWord(words[i]).toLowerCase()]) continue;
      var start = i, j = i - 1, count = 0;
      while (j >= 0 && count < 6) {
        var wj = cleanWord(words[j]);
        if (wj.length > 1 && /^[A-Z]/.test(wj) && !COMPANY_STOPWORDS[wj.toLowerCase()]) { start = j; j--; count++; }
        else break;
      }
      if (start === i) continue; // no capitalized word precedes it - not a real name
      var name = words.slice(start, i + 1).map(cleanWord).join(" ").trim();
      var key = name.toLowerCase();
      if (name.length >= 6 && name.length <= 90 && !seen[key]) { seen[key] = true; out.push(name); }
    }
    return out;
  }

  function findGoverningLaw(text) {
    var prose = text.match(/govern(?:ed|ing)\s+(?:by\s+)?(?:and\s+construed\s+in\s+accordance\s+with\s+)?(?:the\s+)?laws?\s+of\s+(?:the\s+)?([A-Za-z][A-Za-z .,()'’]{2,40}?)(?=[.,;\n]|\s+(?:and|without))/i);
    if (prose) return prose[1].trim();
    var label = text.match(/governing\s+law\s*[:\-]\s*([A-Za-z][A-Za-z .,()'’]{2,40}?)(?=[.,;\n]|$)/i);
    return label ? label[1].trim() : null;
  }

  // Lines that merely MENTION "agreement" as metadata ("Agreement Term: ...", "This
  // Agreement is entered into...", "Reference No: ...") rather than BEING the title.
  var TITLE_EXCLUDE = /^(date|reference|dated|agreement (term|no|number)|term|effective date|expiry date|expiration date|this (agreement|contract)|between|and\b)\s*[:\-]?\s*\d?/i;

  var TITLE_KEYWORD = /\b(agreement|contract|lease|policy|memorandum|nda|letter of intent|statement of work)\b/i;
  // Body text ("XYZ Pte Ltd (Company Registration No. 123456) (the "Lessee") a Lease
  // of...") matches TITLE_KEYWORD just as easily as a real heading does. A real title
  // is short, doesn't cite a registration/UEN number, and doesn't define a defended
  // term in quotes - those are recital-sentence tells, not heading tells.
  var TITLE_BODY_TELLS = /(registration no|company no|uen|reg\.?\s*no|\(the\s+["“]|,\s+having|between\b.*\band\b)/i;

  function guessTitle(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 25);
    var candidates = lines.filter(function (l) {
      return l.length >= 8 && l.length <= 80
        && TITLE_KEYWORD.test(l)
        && l.split(/\s+/).length <= 10 // a heading is a short phrase, not a sentence
        && !/^\d/.test(l) && !TITLE_EXCLUDE.test(l) && !TITLE_BODY_TELLS.test(l);
    });
    // Prefer a candidate that ENDS in the keyword ("... SERVICES AGREEMENT") - how
    // real headings are phrased - over one that merely contains it somewhere.
    var titleLine = candidates.find(function (l) { return /(agreement|contract|lease|policy|memorandum|nda)\s*$/i.test(l); }) || candidates[0];
    if (!titleLine) return null;
    if (titleLine === titleLine.toUpperCase()) {
      titleLine = titleLine.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }
    return titleLine;
  }

  function guessFields(text) {
    var dates = findAllDates(text);
    var startMatch = keywordProximityDate(text, dates, START_KEYWORDS, 60);
    var expiryMatch = keywordProximityDate(text, dates, EXPIRY_KEYWORDS, 60);
    var money = findMoney(text);
    var companies = findCompanies(text, 4);
    var law = findGoverningLaw(text);
    var title = guessTitle(text);

    var guess = {};
    if (title) guess.title = title;
    if (startMatch) guess.startDate = startMatch.iso;
    else if (dates.length) guess.startDate = dates[0].iso; // fall back to earliest date found
    if (expiryMatch) {
      guess.expiryDate = expiryMatch.iso;
    } else if (guess.startDate) {
      // No explicit expiry date - many contracts state a duration instead
      // ("for a term of three (3) years"). Compute it from the start date,
      // and surface the stated term itself so the form shows what was
      // actually found, not just the date it produced.
      var term = findTermMonths(text);
      if (term) {
        guess.expiryDate = addMonthsISO(guess.startDate, term.months);
        guess.termValue = term.value;
        guess.termUnit = term.unit;
      }
    }
    if (money) { guess.value = money.value; guess.currency = money.currency; }
    if (companies.length) guess.counterparty = companies[0];
    if (law) guess.governingLaw = law;

    var fieldsFound = Object.keys(guess).length;
    return { guess: guess, fieldsFound: fieldsFound, companies: companies };
  }

  // ---------- OCR (scanned pages / photographed documents) ----------
  // Runs entirely in the browser via Tesseract.js - no server, no API key. Real
  // tradeoff vs born-digital text: noticeably slower (seconds per page) and
  // meaningfully less accurate on skewed scans, stamps, or handwriting.
  var OCR_MIN_TEXT_LENGTH = 40; // below this, a "text" PDF page is almost certainly a scan

  function ocrImageSource(source, onProgress, pageLabel, lang) {
    if (!global.Tesseract) throw new Error("OCR engine did not load — check your connection and try again.");
    return global.Tesseract.recognize(source, lang || "eng", {
      logger: function (m) {
        if (onProgress && m.status === "recognizing text") onProgress(pageLabel, m.progress);
      }
    }).then(function (result) { return result.data.text; });
  }

  // Grayscale + min-max contrast stretch. Cheap (single pixel pass, no new
  // dependency) but measurably helps Tesseract on the kind of input that
  // actually reaches this fallback: phone photos with glare/shadows, faded
  // carbon-copy prints, low-contrast scans - not just clean digital scans.
  function preprocessCanvasForOcr(canvas) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    if (!w || !h) return canvas;
    var imageData = ctx.getImageData(0, 0, w, h);
    var d = imageData.data;
    var n = w * h;
    var gray = new Uint8ClampedArray(n);
    var min = 255, max = 0;
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      var g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[p] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    var range = max - min || 1;
    for (i = 0, p = 0; i < d.length; i += 4, p++) {
      var v = ((gray[p] - min) * 255) / range;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  // ---------- DIP: image prep shared by OCR and the vision-assisted LLM step ----------
  // Phone photos and low-DPI scans are often small enough that Tesseract loses
  // small print entirely - upscaling before the contrast stretch measurably
  // helps on that class of input, at the cost of a slightly slower OCR pass.
  var OCR_MIN_LONG_EDGE = 1800;
  function upscaleCanvasIfSmall(canvas) {
    var longEdge = Math.max(canvas.width, canvas.height);
    if (longEdge >= OCR_MIN_LONG_EDGE || !longEdge) return canvas;
    var factor = OCR_MIN_LONG_EDGE / longEdge;
    var scaled = document.createElement("canvas");
    scaled.width = Math.round(canvas.width * factor);
    scaled.height = Math.round(canvas.height * factor);
    var ctx = scaled.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    return scaled;
  }

  // Downscaled, JPEG-compressed copy for the LLM vision call - kept separate
  // from the OCR-optimized (upscaled, grayscale) canvas because a vision model
  // wants a reasonably-sized color image, not the largest/highest-contrast one
  // Tesseract prefers. Cropped to Anthropic's recommended long edge so cost/
  // latency stay predictable regardless of the source photo's resolution.
  var LLM_IMAGE_MAX_EDGE = 1568;
  var MAX_LLM_IMAGES = 3;
  function canvasToLlmImage(canvas) {
    var longEdge = Math.max(canvas.width, canvas.height);
    var out = canvas;
    if (longEdge > LLM_IMAGE_MAX_EDGE) {
      var factor = LLM_IMAGE_MAX_EDGE / longEdge;
      out = document.createElement("canvas");
      out.width = Math.round(canvas.width * factor);
      out.height = Math.round(canvas.height * factor);
      var ctx = out.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(canvas, 0, 0, out.width, out.height);
    }
    var dataUrl = out.toDataURL("image/jpeg", 0.85);
    var comma = dataUrl.indexOf(",");
    return { mediaType: "image/jpeg", data: dataUrl.slice(comma + 1) };
  }

  function loadFileToCanvas(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Could not load image.")); };
      img.src = url;
    });
  }

  // OCR_RENDER_SCALE controls the resolution a PDF page is rasterized at
  // before OCR - higher catches small print but costs more time/memory.
  var OCR_RENDER_SCALE = 3;

  function renderPdfPageToCanvas(page, scale) {
    var viewport = page.getViewport({ scale: scale || 2 });
    var canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    var ctx = canvas.getContext("2d");
    return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () { return canvas; });
  }

  // ---------- file readers ----------
  // Every reader resolves { text, images } - images is only ever non-empty for
  // the OCR fallback path (scanned PDFs / photographed pages), and feeds the
  // vision-assisted LLM step below alongside the OCR'd text.
  function extractPdfText(file, onProgress, ocrLang) {
    return file.arrayBuffer().then(function (buf) {
      if (!global.pdfjsLib) throw new Error("PDF reader did not load — check your connection and try again.");
      return global.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      var maxPages = Math.min(pdf.numPages, 25);
      var pagePromises = [];
      for (var i = 1; i <= maxPages; i++) {
        pagePromises.push(pdf.getPage(i).then(function (page) {
          return page.getTextContent().then(function (content) {
            return content.items.map(function (it) { return it.str; }).join(" ");
          });
        }));
      }
      return Promise.all(pagePromises).then(function (pages) { return { pdf: pdf, maxPages: maxPages, text: pages.join("\n") }; });
    }).then(function (result) {
      if (result.text.trim().length >= OCR_MIN_TEXT_LENGTH) return { text: result.text, images: [] };
      // No meaningful embedded text - this is almost certainly a scanned/photographed
      // page, not a digitally-created PDF. Fall back to rendering each page as an
      // image and running OCR on it instead.
      var pdf = result.pdf, maxPages = result.maxPages;
      var chain = Promise.resolve();
      var ocrTexts = [], images = [];
      var _loop = function (i) {
        chain = chain.then(function () {
          return pdf.getPage(i).then(function (page) { return renderPdfPageToCanvas(page, OCR_RENDER_SCALE); })
            .then(function (rawCanvas) {
              if (images.length < MAX_LLM_IMAGES) images.push(canvasToLlmImage(rawCanvas));
              return ocrImageSource(preprocessCanvasForOcr(upscaleCanvasIfSmall(rawCanvas)), onProgress, "page " + i + "/" + maxPages, ocrLang);
            })
            .then(function (text) { ocrTexts.push(text); });
        });
      };
      for (var i = 1; i <= maxPages; i++) _loop(i);
      return chain.then(function () { return { text: ocrTexts.join("\n"), images: images }; });
    });
  }

  function extractImageText(file, onProgress, ocrLang) {
    return loadFileToCanvas(file).then(function (rawCanvas) {
      var images = [canvasToLlmImage(rawCanvas)];
      return ocrImageSource(preprocessCanvasForOcr(upscaleCanvasIfSmall(rawCanvas)), onProgress, "image", ocrLang)
        .then(function (text) { return { text: text, images: images }; });
    });
  }

  function extractDocxText(file) {
    if (!global.JSZip) return Promise.reject(new Error("DOCX reader did not load — check your connection and try again."));
    return file.arrayBuffer().then(function (buf) {
      return global.JSZip.loadAsync(buf);
    }).then(function (zip) {
      var docXml = zip.file("word/document.xml");
      if (!docXml) throw new Error("This doesn't look like a valid .docx file.");
      return docXml.async("string");
    }).then(function (xml) {
      var paragraphs = xml.split(/<w:p[ >]/).slice(1);
      return { text: paragraphs.map(function (p) {
        var runs = p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
        return runs.map(function (r) { return r.replace(/<[^>]+>/g, ""); }).join("");
      }).join("\n"), images: [] };
    });
  }

  function extractTxtText(file) {
    return file.text().then(function (text) { return { text: text, images: [] }; });
  }

  function extractText(file, onProgress, ocrLang) {
    var name = file.name.toLowerCase();
    if (name.endsWith(".pdf")) return extractPdfText(file, onProgress, ocrLang);
    if (name.endsWith(".docx")) return extractDocxText(file);
    if (name.endsWith(".txt")) return extractTxtText(file);
    if (/\.(jpe?g|png|webp|bmp)$/.test(name)) return extractImageText(file, onProgress, ocrLang);
    return Promise.reject(new Error("UNSUPPORTED_TYPE"));
  }

  global.DocketExtract = {
    extractText: extractText,
    guessFields: guessFields
  };
})(window);
