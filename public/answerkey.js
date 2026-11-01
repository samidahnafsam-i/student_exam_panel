/*
 * answerkey.js — answer-key extraction, review and matching (runs 100% in the browser).
 *
 * Works in two places:
 *   - the browser (admin.html):  window.AnswerKey
 *   - Node (tests):              import "./answerkey.js"  ->  globalThis.AnswerKey
 *
 * Pipeline:   PDF ──(PDF.js text layer, else Tesseract OCR)──▶ lines of text
 *             lines ──parseLines──▶ raw entries  ──consolidate──▶ one entry per question number
 *             entries + exam questions ──buildRows──▶ review rows ──applyRows──▶ [{index, answer}]
 *
 * Design rule: NEVER GUESS. Anything that cannot be read unambiguously (bad letter, several letters,
 * conflicting duplicates, low-confidence OCR, label clashes, out-of-range options) is surfaced with a
 * status instead of being turned into an answer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AnswerKey = api; // browser: window.AnswerKey   (Node ESM tests: globalThis.AnswerKey)
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  const LETTERS = "ABCDEF";
  const OCR_LOW_CONF = 75; // OCR lines below this confidence (0-100) are flagged "Needs review"
  const MAX_PAGES = 200;
  const OCR_WIDTHS = [1400, 2200, 1000]; // page render widths (px) tried in this order until OCR looks good
  const OCR_GOOD_ENOUGH = 3; // stop retrying once this many confident answers were read

  /* ------------------------------------------------------------------ */
  /* Status catalogue (used by the review table)                         */
  /* ------------------------------------------------------------------ */
  const STATUS_INFO = {
    valid: { label: "Valid", level: "ok" },
    duplicate: { label: "Duplicate (same answer)", level: "warn" },
    review: { label: "Needs review", level: "warn" },
    invalid: { label: "Invalid", level: "bad" },
    ambiguous: { label: "Ambiguous", level: "bad" },
    conflict: { label: "Duplicate (conflict)", level: "bad" },
    range: { label: "Out of range", level: "bad" },
    missing: { label: "Missing", level: "bad" },
    unmatched: { label: "No matching question", level: "bad" },
    labelclash: { label: "Label clash", level: "bad" },
    nolabel: { label: "No question number", level: "bad" },
  };
  const APPLICABLE = new Set(["valid", "duplicate", "review"]);

  /* ------------------------------------------------------------------ */
  /* Text helpers                                                        */
  /* ------------------------------------------------------------------ */
  function normalizeText(s) {
    return String(s == null ? "" : s)
      .normalize("NFKC") // full-width digits/letters/colons -> ASCII
      .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "")
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\t]/g, " ")
      .replace(/[\u2010-\u2015\u2212]/g, "-") // every kind of dash/minus -> "-"
      .replace(/[\u2022\u00b7\u25cf\u25aa]/g, " ")
      .replace(/\r/g, "")
      .replace(/ {2,}/g, " ");
  }

  /**
   * PDF.js text items -> visual lines. Items on (nearly) the same baseline are joined left-to-right,
   * which keeps table rows ("1   A   11   C") and two-column layouts together on one line.
   */
  function pageItemsToLines(items) {
    const toks = [];
    for (const it of items || []) {
      if (!it || typeof it.str !== "string" || !it.str.trim()) continue;
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      const size = Math.abs(t[3]) || Math.abs(it.height) || 10;
      toks.push({ str: it.str, x: t[4] || 0, y: t[5] || 0, w: it.width || 0, size });
    }
    toks.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const t of toks) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - t.y) <= Math.max(2, last.size * 0.5)) last.items.push(t);
      else rows.push({ y: t.y, size: t.size, items: [t] });
    }
    return rows
      .map((r) => {
        r.items.sort((a, b) => a.x - b.x);
        let s = "";
        let prevEnd = null;
        for (const it of r.items) {
          if (prevEnd !== null && it.x - prevEnd > r.size * 0.12 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += " ";
          s += it.str;
          prevEnd = it.x + it.w;
        }
        return normalizeText(s).trim();
      })
      .filter(Boolean);
  }

  /** Tesseract result -> [{text, conf, words:[{text,conf}]}] (works with v5 `lines` and with `blocks`-only output). */
  function ocrLines(data) {
    if (!data) return [];
    const wordsOf = (l) => (Array.isArray(l.words) ? l.words.map((w) => ({ text: w.text, conf: w.confidence })) : null);
    if (Array.isArray(data.lines) && data.lines.length) return data.lines.map((l) => ({ text: l.text, conf: l.confidence, words: wordsOf(l) }));
    if (Array.isArray(data.blocks)) {
      const out = [];
      for (const b of data.blocks)
        for (const p of b.paragraphs || []) for (const l of p.lines || []) out.push({ text: l.text, conf: l.confidence, words: wordsOf(l) });
      if (out.length) return out;
    }
    return String(data.text || "")
      .split("\n")
      .map((t) => ({ text: t, conf: typeof data.confidence === "number" ? data.confidence : null }));
  }

  /* ------------------------------------------------------------------ */
  /* Parsing                                                             */
  /* ------------------------------------------------------------------ */
  // Everything below is matched case-insensitively ("gi").
  const PREFIX = "(?:(?:question|ques|qn|q|answer|ans|no)\\s*[.:]?\\s*(?:no\\.?\\s*|#\\s*)?)";
  const LABEL = "(?:(?:correct\\s+)?(?:answer|ans|key|option|opt)\\s*[.:=-]*\\s*)";
  // One letter (optionally in brackets), several alternatives ("A/B", "A, B", "A or B"), or glued letters ("AB").
  const ANS = "(?:[(\\[]?[a-z][)\\]]?(?:\\s*(?:[\\/,&]|\\bor\\b|\\band\\b)\\s*[(\\[]?[a-z][)\\]]?)*|[a-f]{2,4})";
  const PAIR_SRC =
    "(^|[^a-z0-9])" + // 1 lead (so "A1" / "2023" can't start a pair)
    "(" + PREFIX + ")?" + // 2 Q / Question / Ans …
    "\\(?(\\d{1,3})(?!\\d)" + // 3 question number
    "(\\s*[.):\\-=|\\]>]+\\s*|\\s+)" + // 4 separator:  .  )  :  -  =  |  or plain space
    "(" + LABEL + ")?" + // 5 optional "Answer:" label
    "(" + ANS + ")" + // 6 the answer
    "(?![a-z0-9])";

  function classify(tok) {
    const t = tok.replace(/\b(?:or|and)\b/gi, " ");
    const letters = (t.match(/[a-z]/gi) || []).map((c) => c.toUpperCase());
    if (letters.length === 1) {
      const L = letters[0];
      return LETTERS.includes(L)
        ? { status: "valid", answer: L, candidates: [L] }
        : { status: "invalid", answer: null, candidates: [] };
    }
    const uniq = [...new Set(letters)];
    return { status: "ambiguous", answer: null, candidates: uniq.filter((l) => LETTERS.includes(l)) };
  }

  /** All "number + answer" pairs on one line: "1. A", "Q2: B", "Question 3 - Answer: C", "4 | D", "5. A, 6. B" … */
  function parsePairs(line) {
    const out = [];
    const re = new RegExp(PAIR_SRC, "gi");
    let m;
    while ((m = re.exec(line))) {
      const full = m[0];
      const prefix = m[2], num = m[3], sep = m[4], label = m[5], ans = m[6];
      if (full.length === 0) { re.lastIndex++; continue; }
      const q = parseInt(num, 10);
      if (!q) continue;
      const rest = line.slice(m.index + full.length);
      const bare = /^\s+$/.test(sep);
      const strong = !!prefix || !!label || !bare;
      // "1 A" with nothing else to say it's an answer key: only accept when followed by end / next pair.
      if (!strong && !/^\s*(?:$|[,;|]|\(?\d|(?:q|question|ques|qn)\s*[.:]?\s*\d)/i.test(rest)) continue;
      // "1. A man walks…" is a sentence, not an answer.
      if (!label && /^[a-z]$/i.test(ans.trim()) && /^\s+[a-z]{2,}/.test(rest)) continue;
      // Glued letters must be written in capitals ("AB"), otherwise "Dead", "Face", "Bad" would match.
      if (/^[a-z]{2,4}$/i.test(ans) && ans !== ans.toUpperCase()) continue;
      out.push(Object.assign({ q, raw: ans.trim(), start: m.index + m[1].length, end: m.index + full.length }, classify(ans)));
    }
    return out;
  }

  const COMPACT_LINE = /^(?:\d{1,3}\s*[a-f](?![a-z0-9])[\s,;]*)+$/i; // "1A 2B 3C"
  const GRID_NUMS = /^\s*(?:(?:q(?:uestion)?s?|no|sl|s\.?n)\.?\s*(?:no\.?|number|#)?\s*[:.\-]?\s*)?((?:\d{1,3}[\s,]+){2,}\d{1,3})\s*$/i;
  const GRID_LETTERS = /^\s*(?:(?:correct\s+)?(?:answers?|ans|key)\s*[:.\-=]?\s*)?((?:[a-z][\s,]+){2,}[a-z])\s*$/i;

  /** Normalise one input line; when per-word OCR confidences are given, remember which characters belong to which word. */
  function prepLine(l) {
    if (typeof l === "string") l = { text: l };
    if (Array.isArray(l.words) && l.words.length) {
      const spans = [];
      let text = "";
      for (const w of l.words) {
        const t = normalizeText(w.text).trim();
        if (!t) continue;
        if (text) text += " ";
        spans.push({ s: text.length, e: text.length + t.length, c: w.conf == null ? null : Number(w.conf) });
        text += t;
      }
      return { text, conf: l.conf == null ? null : Number(l.conf), spans };
    }
    return { text: normalizeText(l.text).trim(), conf: l.conf == null ? null : Number(l.conf), spans: null };
  }
  /** Confidence of just the words that make up characters [start,end) — a shaky neighbour must not taint a clear answer. */
  function confFor(line, start, end) {
    if (!line.spans) return line.conf;
    let min = null;
    for (const sp of line.spans) if (sp.s < end && sp.e > start && sp.c != null) min = min == null ? sp.c : Math.min(min, sp.c);
    return min == null ? line.conf : min;
  }

  /**
   * lines: [{text, conf?, words?}]  ->  { entries, warnings }
   * entry: {q, status:'valid'|'invalid'|'ambiguous', answer, candidates, raw, line, conf, weak?}
   */
  function parseLines(lineObjs) {
    const entries = [];
    const warnings = [];
    const lines = (lineObjs || []).map(prepLine).filter((l) => l.text);

    const used = new Set();

    // 1) normal pass: every line may contain several pairs
    lines.forEach((l, i) => {
      const got = parsePairs(l.text);
      if (!got.length) return;
      used.add(i);
      got.forEach((e) => entries.push(Object.assign(e, { line: i, conf: confFor(l, e.start, e.end), text: l.text })));
      // OCR often drops the full stop ("5.A" -> "5A"). Accept such glued tokens, but ONLY when everything else on the
      // line is a clean pair, so ordinary prose like "Table 2A" can never match.
      let left = l.text;
      for (const e of got) left = left.slice(0, e.start) + " ".repeat(e.end - e.start) + left.slice(e.end);
      const rest = left.replace(/[\s,;|.]+/g, " ").trim();
      if (rest && /^(?:\d{1,3}[a-f](?![a-z0-9])\s*)+$/i.test(rest)) {
        for (const t of left.matchAll(/(\d{1,3})\s*([a-f])(?![a-z0-9])/gi)) {
          const q = parseInt(t[1], 10);
          if (!q) continue;
          const a = t[2].toUpperCase();
          entries.push({ q, raw: a, status: "valid", answer: a, candidates: [a], line: i, conf: confFor(l, t.index, t.index + t[0].length), text: l.text, start: t.index, end: t.index + t[0].length });
        }
      }
    });

    // 2) compact tokens "1A 2B 3C" (only when the whole line is such tokens, and there are enough of them)
    const compact = [];
    lines.forEach((l, i) => {
      if (used.has(i) || !COMPACT_LINE.test(l.text)) return;
      for (const t of l.text.matchAll(/(\d{1,3})\s*([a-f])(?![a-z0-9])/gi)) compact.push({ i, l, q: parseInt(t[1], 10), a: t[2].toUpperCase() });
    });
    if (compact.length >= 3) {
      for (const c of compact) {
        if (!c.q) continue;
        used.add(c.i);
        entries.push({ q: c.q, raw: c.a, status: "valid", answer: c.a, candidates: [c.a], line: c.i, conf: c.l.conf, text: c.l.text });
      }
    }

    // 3) "grid" layout: a row of numbers followed by a row of letters
    for (let i = 0; i < lines.length - 1; i++) {
      if (used.has(i)) continue;
      const nm = GRID_NUMS.exec(lines[i].text);
      if (!nm) continue;
      const lm = GRID_LETTERS.exec(lines[i + 1].text);
      if (!lm) continue;
      const nums = nm[1].split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 10));
      const lets = lm[1].split(/[\s,]+/).filter(Boolean);
      if (nums.length !== lets.length) {
        warnings.push(
          `A table row lists ${nums.length} question numbers (${nums[0]}–${nums[nums.length - 1]}) but ${lets.length} answers. It was skipped because the pairing is uncertain; enter those answers manually.`
        );
        i++;
        continue;
      }
      nums.forEach((q, k) => {
        if (!q) return;
        const c = classify(lets[k]);
        entries.push(Object.assign({ q, raw: lets[k], line: i, conf: lines[i + 1].conf, text: lines[i].text + " / " + lines[i + 1].text }, c));
      });
      used.add(i); used.add(i + 1);
      i++;
    }

    // 4) last resort when nothing at all was found: the number and the answer may sit on different lines
    if (!entries.length && lines.length > 1) {
      const joined = lines.map((l) => l.text).join(" ");
      for (const e of parsePairs(joined)) entries.push(Object.assign(e, { line: -1, conf: null, text: "(joined lines)", weak: true }));
    }

    return { entries, warnings };
  }

  /** pages: [{page, via:'text'|'ocr', lines:[{text,conf}]}] -> flat raw entries (tagged with page/via) + warnings */
  function parsePages(pages) {
    const entries = [];
    const warnings = [];
    for (const p of pages) {
      const r = parseLines(p.lines);
      r.entries.forEach((e) => entries.push(Object.assign(e, { page: p.page, via: p.via })));
      r.warnings.forEach((w) => warnings.push(`Page ${p.page}: ${w}`));
    }
    return { entries, warnings };
  }

  /* ------------------------------------------------------------------ */
  /* Consolidation: one entry per question number                        */
  /* ------------------------------------------------------------------ */
  function consolidate(rawEntries) {
    const byQ = new Map();
    for (const e of rawEntries) {
      if (!byQ.has(e.q)) byQ.set(e.q, []);
      byQ.get(e.q).push(e);
    }
    const out = [];
    for (const q of [...byQ.keys()].sort((a, b) => a - b)) {
      const list = byQ.get(q);
      const raws = list.map((e) => e.raw);
      const pages = [...new Set(list.map((e) => e.page).filter((x) => x != null))];
      const base = { q, count: list.length, raw: raws.join(" / "), pages, via: list[0].via || "text" };

      if (list.length === 1) {
        const e = list[0];
        let status = e.status;
        let note = "";
        let answer = "";
        let candidates = e.candidates || [];
        if (e.status === "valid") {
          answer = e.answer;
          if (e.weak) { status = "review"; note = "The number and the answer were on separate lines"; }
          else if (e.conf != null && e.conf < OCR_LOW_CONF) { status = "review"; note = `Low OCR confidence (${Math.round(e.conf)}%) – check the PDF`; }
        } else if (e.status === "invalid") {
          note = `Read “${e.raw}”, which is not an option A–F`;
        } else {
          note = `More than one answer found: “${e.raw}”`;
        }
        out.push(Object.assign(base, { status, answer, candidates, note }));
      } else {
        const valid = [...new Set(list.filter((e) => e.status === "valid").map((e) => e.answer))];
        const cands = [...new Set(list.flatMap((e) => e.candidates || []))];
        if (list.every((e) => e.status === "valid") && valid.length === 1) {
          out.push(Object.assign(base, { status: "duplicate", answer: valid[0], candidates: valid, note: `Listed ${list.length} times, always ${valid[0]}` }));
        } else {
          out.push(Object.assign(base, { status: "conflict", answer: "", candidates: cands, note: `Listed ${list.length} times with different results: ${raws.join(", ")}` }));
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Matching to exam questions                                          */
  /* ------------------------------------------------------------------ */
  function parseExamLabel(label) {
    const s = String(label == null ? "" : label).trim();
    if (!s) return { kind: "none" };
    const m = s.match(/^(?:q(?:uestion)?\s*\.?\s*)?(\d{1,3})\s*[.):]?$/i);
    if (m) return { kind: "num", num: parseInt(m[1], 10) };
    return { kind: "other", label: s };
  }

  /**
   * Decide which key number each exam question answers to.
   *  - explicit numeric label  -> that number           (never replaced by upload order)
   *  - no label at all         -> offset + position     (fallback), unless another question already owns that number
   *  - label that isn't a plain number ("12a") -> no number (reported)
   */
  function numberExamQuestions(items, offset) {
    const infos = items.map((it, index) => ({ index, parsed: parseExamLabel(it.label), num: null, via: "", issue: "" }));
    const explicit = new Map();
    for (const n of infos) {
      if (n.parsed.kind === "num") {
        n.num = n.parsed.num; n.via = "label";
        if (!explicit.has(n.num)) explicit.set(n.num, []);
        explicit.get(n.num).push(n.index);
      }
    }
    for (const n of infos) {
      if (n.parsed.kind === "none") {
        const p = offset + n.index;
        if (explicit.has(p)) n.issue = `Question at position ${n.index + 1} has no number, and key number ${p} already belongs to a question labelled ${p}. Give it a number.`;
        else { n.num = p; n.via = "order"; }
      } else if (n.parsed.kind === "other") {
        n.issue = `Question at position ${n.index + 1} is labelled “${n.parsed.label}”, which is not a plain number, so it cannot be matched to the key. Change its label.`;
      }
    }
    return infos;
  }

  /**
   * consolidated: output of consolidate()
   * items: [{label, options}]  (the exam questions, in their current order)
   * opts:  { offset=1, edits={[q]:'A'|''}, ignored=[q] }
   */
  function buildRows(consolidated, items, opts) {
    opts = opts || {};
    const offset = Number.isInteger(opts.offset) ? opts.offset : 1;
    const edits = opts.edits || {};
    const ignored = new Set(opts.ignored || []);
    const infos = numberExamQuestions(items, offset);

    const byNum = new Map();
    for (const n of infos) {
      if (n.num == null) continue;
      if (!byNum.has(n.num)) byNum.set(n.num, []);
      byNum.get(n.num).push(n.index);
    }
    const ext = new Map(consolidated.map((c) => [c.q, c]));
    const nums = [...new Set([...ext.keys(), ...byNum.keys()])].sort((a, b) => a - b);

    const rows = [];
    for (const q of nums) {
      const e = ext.get(q) || null;
      const idxs = byNum.get(q) || [];
      const item = idxs.length === 1 ? items[idxs[0]] : null;
      const optCount = item ? item.options || 4 : 6;
      const hasEdit = Object.prototype.hasOwnProperty.call(edits, q);
      const row = {
        q, itemIndex: item ? idxs[0] : -1, matchedBy: item ? infos[idxs[0]].via : "",
        extracted: e ? e.answer : "", raw: e ? e.raw : "", candidates: e ? e.candidates : [],
        pages: e ? e.pages : [], via: e ? e.via : "", answer: "", status: "", note: "", edited: false, hasExtract: !!e,
      };

      if (idxs.length > 1) {
        row.status = "labelclash";
        row.note = `Label ${q} is used by questions at positions ${idxs.map((i) => i + 1).join(", ")}. Make the labels unique.`;
      } else if (!item) {
        if (ignored.has(q)) continue;
        row.answer = hasEdit ? edits[q] : row.extracted;
        row.status = "unmatched";
        row.note = `The key has an answer for question ${q}, but no exam question has this number.`;
        row.edited = hasEdit;
      } else if (hasEdit) {
        row.edited = true;
        row.answer = edits[q];
        if (!row.answer) { row.status = "missing"; row.note = "Cleared – no answer"; }
        else if (LETTERS.indexOf(row.answer) < 0 || LETTERS.indexOf(row.answer) >= optCount) { row.status = "range"; row.note = `${row.answer} is outside this question's ${optCount} options`; }
        else { row.status = "valid"; row.note = "Entered/edited by you"; }
      } else if (!e) {
        row.status = "missing";
        row.note = "Not found in the answer key";
      } else {
        row.answer = e.answer;
        row.status = e.status;
        row.note = e.note;
        if (row.answer && LETTERS.indexOf(row.answer) >= optCount) {
          row.status = "range";
          row.note = `${row.answer} is outside this question's ${optCount} options`;
        }
      }
      row.canApply = !!item && !!row.answer && APPLICABLE.has(row.status);
      rows.push(row);
    }

    // exam questions that cannot be given a key number at all
    for (const n of infos) {
      if (n.num == null && n.issue) {
        rows.push({
          q: null, itemIndex: n.index, matchedBy: "", extracted: "", raw: "", candidates: [], pages: [], via: "",
          answer: "", status: "nolabel", note: n.issue, edited: false, hasExtract: false, canApply: false,
        });
      }
    }

    /* ---- summary ---- */
    const detected = consolidated.length;
    const matchedNums = rows.filter((r) => r.hasExtract && r.itemIndex >= 0).length;
    const unmatchedNums = rows.filter((r) => r.status === "unmatched" && r.hasExtract).map((r) => r.q);
    const missingNums = rows.filter((r) => r.q != null && r.itemIndex >= 0 && !r.answer).map((r) => r.q);
    const applicable = rows.filter((r) => r.canApply).length;
    const warnings = [];
    if (detected !== items.length)
      warnings.push(`The answer key lists ${detected} question number${detected === 1 ? "" : "s"}, but the exam has ${items.length} question${items.length === 1 ? "" : "s"}.`);
    if (rows.some((r) => r.matchedBy === "order"))
      warnings.push(`Questions without a number label are matched by upload order (the first one = key number ${offset}). Give your questions number labels if the order might differ from the key.`);
    if (unmatchedNums.length) warnings.push(`Key numbers with no matching exam question: ${listNums(unmatchedNums)}.`);
    if (missingNums.length) warnings.push(`Exam questions with no usable answer yet: ${listNums(missingNums)}.`);
    for (const n of infos) if (n.num == null && n.issue) warnings.push(n.issue);
    const dupLabels = rows.filter((r) => r.status === "labelclash").map((r) => r.q);
    if (dupLabels.length) warnings.push(`Duplicate question labels: ${listNums(dupLabels)}.`);

    const counts = {};
    rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const needsAttention = rows.filter((r) => r.status !== "valid").length;

    return {
      rows,
      summary: { detected, examQuestions: items.length, matched: matchedNums, unmatched: unmatchedNums.length, missing: missingNums.length, applicable, needsAttention, counts, warnings },
    };
  }

  function listNums(a) {
    const s = a.slice(0, 15).join(", ");
    return a.length > 15 ? `${s} … (+${a.length - 15} more)` : s;
  }

  /** rows -> [{index, answer}] — ONLY rows that are matched, in range, and not flagged invalid/ambiguous/conflicting. */
  function applyRows(rows) {
    return rows.filter((r) => r.canApply).map((r) => ({ index: r.itemIndex, answer: r.answer }));
  }

  /* ------------------------------------------------------------------ */
  /* PDF -> raw entries (text layer first, OCR when needed)              */
  /* ------------------------------------------------------------------ */
  class KeyExtractError extends Error {
    constructor(message, code) { super(message); this.name = "KeyExtractError"; this.code = code || "error"; }
  }

  function mapPdfError(e) {
    const name = (e && e.name) || "";
    const msg = (e && e.message) || String(e);
    if (name === "PasswordException") return new KeyExtractError("This PDF is password-protected. Remove the password and try again.", "password");
    if (name === "InvalidPDFException" || /invalid pdf|format error|bad xref|xref|unexpected server response/i.test(msg))
      return new KeyExtractError("This file could not be read as a PDF – it may be corrupted or not a real PDF.", "corrupt");
    if (name === "MissingPDFException") return new KeyExtractError("The PDF could not be found.", "missing");
    return new KeyExtractError("Could not open this PDF: " + msg, "open");
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** How many distinct, confidently-read answers an OCR attempt produced (used to choose the best attempt). */
  function ocrScore(lines) {
    const seen = new Set();
    for (const e of parseLines(lines).entries) if (e.status === "valid" && (e.conf == null || e.conf >= OCR_LOW_CONF)) seen.add(e.q);
    return seen.size;
  }

  /**
   * deps: { pdfjsLib, createOcr?: async (log)=>({recognize(canvas)->tesseractData, terminate()}), renderPage?: async (page, widthPx)=>canvas, docOptions?: extra pdf.js getDocument options }
   * opts: { pages?:[1-based page numbers], forceOcr?:bool, onProgress?:fn, signal?:{cancelled:bool} }
   */
  async function extractFromPdf(data, deps, opts) {
    opts = opts || {};
    const { pdfjsLib, createOcr, renderPage } = deps;
    const progress = opts.onProgress || function () {};
    const cancelled = () => !!(opts.signal && opts.signal.cancelled);
    const checkCancel = () => { if (cancelled()) throw new KeyExtractError("Extraction cancelled.", "cancelled"); };

    // Always give PDF.js its own plain Uint8Array copy (it rejects Node Buffers, and transfers/detaches what it is given).
    const src = data instanceof Uint8Array ? data : new Uint8Array(data);
    const bytes = new Uint8Array(src.length);
    bytes.set(src);
    if (!bytes.length) throw new KeyExtractError("The file is empty.", "empty");
    let head = "";
    for (let i = 0; i < Math.min(bytes.length, 1024); i++) head += String.fromCharCode(bytes[i]);
    if (head.indexOf("%PDF-") < 0) throw new KeyExtractError("This file is not a PDF. Please choose a .pdf file.", "notpdf");

    progress({ stage: "open", fraction: 0, message: "Opening PDF…" });
    let pdf;
    try { pdf = await pdfjsLib.getDocument(Object.assign({}, deps.docOptions || {}, { data: new Uint8Array(bytes) })).promise; } catch (e) { throw mapPdfError(e); }

    let pageNums = opts.pages && opts.pages.length ? opts.pages.filter((p) => p >= 1 && p <= pdf.numPages) : Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    if (!pageNums.length) throw new KeyExtractError(`No valid pages selected (the PDF has ${pdf.numPages} pages).`, "pages");
    if (pageNums.length > MAX_PAGES) throw new KeyExtractError(`This PDF has ${pageNums.length} pages (limit ${MAX_PAGES}). Use the page range box to choose the answer pages.`, "toomany");

    /* ---- pass 1: text layer ---- */
    const pages = [];
    for (let k = 0; k < pageNums.length; k++) {
      checkCancel();
      const pn = pageNums[k];
      progress({ stage: "text", fraction: (k / pageNums.length) * (opts.forceOcr ? 0.05 : 0.3), message: `Reading text… page ${pn} (${k + 1}/${pageNums.length})` });
      let lines = [];
      try {
        const page = await pdf.getPage(pn);
        const tc = await page.getTextContent();
        lines = pageItemsToLines(tc.items);
        if (page.cleanup) page.cleanup();
      } catch (e) {
        throw new KeyExtractError(`Page ${pn} could not be read: ${(e && e.message) || e}`, "page");
      }
      const chars = lines.join("").replace(/\s/g, "").length;
      pages.push({ page: pn, via: "text", chars, lines: lines.map((t) => ({ text: t, conf: null })) });
      if (k % 5 === 4) await tick();
    }

    let textParse = parsePages(pages);
    const warnings = [...textParse.warnings];

    /* ---- decide which pages need OCR ---- */
    let ocrPages;
    if (opts.forceOcr || textParse.entries.length === 0) ocrPages = pages.slice();
    else ocrPages = pages.filter((p) => p.chars < 30); // image-only pages inside an otherwise text PDF

    let usedOcr = false;
    if (ocrPages.length) {
      if (typeof createOcr !== "function" || typeof renderPage !== "function")
        throw new KeyExtractError("OCR is not available in this environment.", "noocr");
      checkCancel();
      progress({ stage: "ocr-load", fraction: 0.3, message: "No readable text found – loading the OCR engine (first time only, about 10 MB)…" });
      let ocr;
      try {
        ocr = await createOcr((m) => {
          if (m && m.status && m.status !== "recognizing text") progress({ stage: "ocr-load", fraction: 0.3, message: "Preparing OCR: " + String(m.status).replace(/_/g, " ") + "…" });
        });
      } catch (e) {
        throw new KeyExtractError("Could not load the OCR engine (" + ((e && e.message) || e) + "). Check your internet connection and try again.", "ocr-load");
      }
      try {
        for (let k = 0; k < ocrPages.length; k++) {
          checkCancel();
          const p = ocrPages[k];
          const base = 0.35 + (k / ocrPages.length) * 0.65;
          progress({ stage: "ocr", fraction: base, message: `OCR: reading page ${p.page} (${k + 1}/${ocrPages.length})…` });
          const page = await pdf.getPage(p.page);
          // Tesseract is very sensitive to text size in pixels: too small OR too big (upscaling a low-res scan) both fail.
          // Try a sensible width first and only retry at other widths when the result is poor; keep the best attempt.
          let best = null;
          for (let a = 0; a < OCR_WIDTHS.length; a++) {
            checkCancel();
            const canvas = await renderPage(page, OCR_WIDTHS[a]);
            const result = await ocr.recognize(canvas, (frac) =>
              progress({ stage: "ocr", fraction: base + (frac / ocrPages.length) * 0.65, message: `OCR: reading page ${p.page} (${k + 1}/${ocrPages.length})${a ? ", retry " + a : ""} – ${Math.round(frac * 100)}%` })
            );
            const lines = ocrLines(result);
            const score = ocrScore(lines);
            if (!best || score > best.score) best = { lines, score };
            if (score >= OCR_GOOD_ENOUGH) break;
          }
          p.lines = best.lines;
          p.via = "ocr";
          if (page.cleanup) page.cleanup();
          await tick();
        }
        usedOcr = true;
      } finally {
        try { await ocr.terminate(); } catch (_) { /* ignore */ }
      }
    }

    const parsed = parsePages(pages);
    const ocrWarn = parsed.warnings.filter((w) => !warnings.includes(w));
    warnings.push(...ocrWarn);
    const textCount = pages.filter((p) => p.via === "text").length;
    const method = usedOcr ? (textCount ? "text+ocr" : "ocr") : "text";
    progress({ stage: "done", fraction: 1, message: "Done." });
    return { entries: parsed.entries, warnings, method, pageCount: pageNums.length, ocrPageCount: usedOcr ? ocrPages.length : 0 };
  }

  return {
    LETTERS, OCR_LOW_CONF, STATUS_INFO, APPLICABLE,
    normalizeText, pageItemsToLines, ocrLines,
    parsePairs, parseLines, parsePages, consolidate,
    parseExamLabel, numberExamQuestions, buildRows, applyRows,
    KeyExtractError, mapPdfError, extractFromPdf,
  };
});
