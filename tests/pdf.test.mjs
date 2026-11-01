// Integration tests: the REAL extraction pipeline with REAL PDF.js and REAL Tesseract OCR on real PDF files.
// Needs the heavy dev dependencies:  cd tests && npm install
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import "../public/answerkey.js";

const AK = globalThis.AnswerKey;
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, "fixtures", n));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "expected.json"), "utf8"));
const KEY = EXPECTED.key;

const require = createRequire(import.meta.url);
let pdfjsLib, Tesseract, createCanvas, langPath, skip = false;
try {
  pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
  Tesseract = require("tesseract.js");
  ({ createCanvas } = require("canvas"));
  langPath = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0");
} catch (e) {
  skip = "heavy test deps not installed (cd tests && npm install)";
}

// --- adapters with the same shape as the browser ones in admin.html ---
const renderPage = async (page, width) => {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  const cv = createCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return cv;
};
let ocrCreated = 0;
const createOcr = async (log) => {
  ocrCreated++;
  const worker = await Tesseract.createWorker("eng", 1, { langPath, gzip: true, cachePath: path.join(os.tmpdir(), "tess-cache"), logger: log });
  let cb = () => {};
  return {
    async recognize(cv, onFrac) { cb = onFrac || cb; const { data } = await worker.recognize(cv.toBuffer("image/png")); return data; },
    terminate: () => worker.terminate(),
  };
};
const docOptions = skip ? {} : { standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep };
const run = (name, opts = {}) => AK.extractFromPdf(fx(name), { pdfjsLib, createOcr, renderPage, docOptions }, opts);
const answers = (entries) => Object.fromEntries(AK.consolidate(entries).map((c) => [c.q, c.status === "valid" ? c.answer : c.status]));
const blank = (n = 20) => Array.from({ length: n }, () => ({ label: "", options: 4 }));
const T = { skip, timeout: 240000 };

test("TEXT pdf, every format in one document (1., 2), 3.B,4.D, Q6:, Question 8 - Answer:, 10 -, 11 |, 12 =, table, grid)", T, async () => {
  const r = await run("key_text_formats.pdf");
  assert.equal(r.method, "text");
  assert.equal(r.ocrPageCount, 0);
  assert.deepEqual(answers(r.entries), KEY);
});

test("TEXT pdf, clean two-page table", T, async () => {
  const r = await run("key_text_table.pdf");
  assert.equal(r.method, "text"); assert.equal(r.pageCount, 2);
  assert.deepEqual(answers(r.entries), KEY);
});

test("MISSING answers (5, 9, 14): detected 17, the 3 gaps are flagged, nothing invented", T, async () => {
  const r = await run("key_text_missing.pdf");
  const c = AK.consolidate(r.entries);
  assert.equal(c.length, 17);
  const { rows, summary } = AK.buildRows(c, blank());
  assert.deepEqual(rows.filter((x) => x.status === "missing").map((x) => x.q), EXPECTED.missing);
  assert.equal(summary.applicable, 17); assert.equal(summary.missing, 3);
  assert.ok(summary.warnings.some((w) => /lists 17.*exam has 20/.test(w)));
  assert.ok(AK.applyRows(rows).every((a) => a.answer === KEY[a.index + 1]));
});

test("DUPLICATE question numbers: same answer -> duplicate; conflicting -> blocked, no answer chosen", T, async () => {
  const r = await run("key_text_duplicates.pdf");
  const c = Object.fromEntries(AK.consolidate(r.entries).map((x) => [x.q, x]));
  assert.equal(c[3].status, "duplicate"); assert.equal(c[3].answer, "B"); assert.equal(c[3].count, 2);
  assert.equal(c[7].status, "conflict"); assert.equal(c[7].answer, ""); assert.deepEqual(c[7].candidates.sort(), ["A", "D"]);
  const { rows } = AK.buildRows(Object.values(c), blank());
  assert.equal(rows.find((x) => x.q === 7).canApply, false);
  assert.equal(rows.find((x) => x.q === 3).canApply, true);
});

test("INVALID option letters (G, AB, A/C, Z) are flagged and never applied", T, async () => {
  const r = await run("key_text_invalid.pdf");
  const c = Object.fromEntries(AK.consolidate(r.entries).map((x) => [x.q, x]));
  assert.equal(c[4].status, "invalid");   assert.equal(c[15].status, "invalid");
  assert.equal(c[8].status, "ambiguous"); assert.deepEqual(c[8].candidates, ["A", "B"]);
  assert.equal(c[12].status, "ambiguous"); assert.deepEqual(c[12].candidates, ["A", "C"]);
  const { rows } = AK.buildRows(Object.values(c), blank());
  const applied = Object.fromEntries(AK.applyRows(rows).map((a) => [a.index + 1, a.answer]));
  for (const bad of [4, 8, 12, 15]) assert.equal(applied[bad], undefined);
  assert.equal(Object.keys(applied).length, 16);
  for (const [n, a] of Object.entries(applied)) assert.equal(a, KEY[n]);
});

test("SCANNED (image-only) pdf: falls back to OCR; nothing wrong is ever shown as a confident answer", T, async () => {
  const progress = [];
  const r = await run("key_scanned.pdf", { onProgress: (p) => progress.push(p) });
  assert.equal(r.method, "ocr"); assert.equal(r.ocrPageCount, 1);
  const c = AK.consolidate(r.entries);
  const got = Object.fromEntries(c.map((x) => [x.q, x]));
  let correct = 0;
  for (const [q, a] of Object.entries(KEY)) {
    const x = got[q];
    if (x && x.status === "valid" && x.answer === a) correct++;
    // a wrong answer must NEVER be reported as plain "valid"
    if (x && x.status === "valid") assert.equal(x.answer, a, `Q${q} read wrongly as valid`);
  }
  console.log(`      OCR read ${correct}/20 correctly, ${c.length} entries, statuses:`, JSON.stringify(c.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {})));
  assert.ok(correct >= 18, `only ${correct}/20 correct`);
  assert.ok(progress.some((p) => p.stage === "ocr-load") && progress.some((p) => p.stage === "ocr") && progress.at(-1).stage === "done");
  assert.ok(progress.every((p, i) => i === 0 || p.fraction + 1e-9 >= progress[i - 1].fraction - 0.31), "progress should not jump around");
});

test("MIXED pdf: text page read directly, image-only page OCR'd (per-page decision)", T, async () => {
  const r = await run("key_mixed_text_and_scan.pdf");
  assert.equal(r.method, "text+ocr"); assert.equal(r.ocrPageCount, 1);
  const c = Object.fromEntries(AK.consolidate(r.entries).map((x) => [x.q, x]));
  for (let q = 1; q <= 10; q++) { assert.equal(c[q].status, "valid"); assert.equal(c[q].answer, KEY[q]); assert.equal(c[q].via, "text"); }
  let ok = 0;
  for (let q = 11; q <= 20; q++) if (c[q] && c[q].answer === KEY[q]) ok++;
  assert.ok(ok >= 9, `OCR page: ${ok}/10`);
});

test("Force OCR re-reads a text PDF through OCR", T, async () => {
  const r = await run("key_text_missing.pdf", { forceOcr: true });
  assert.ok(r.method.includes("ocr"));
  const c = AK.consolidate(r.entries);
  for (const x of c) if (x.status === "valid") assert.equal(x.answer, KEY[x.q]);
  assert.ok(c.length >= 15);
});

test("page range selection", T, async () => {
  const r = await run("key_text_table.pdf", { pages: [2] });
  assert.equal(r.pageCount, 1);
  assert.deepEqual(Object.keys(answers(r.entries)).map(Number), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  await assert.rejects(run("key_text_table.pdf", { pages: [9] }), (e) => e.code === "pages");
});

test("cancel stops extraction", T, async () => {
  const signal = { cancelled: false };
  await assert.rejects(run("key_text_table.pdf", { signal, onProgress: () => { signal.cancelled = true; } }), (e) => e.code === "cancelled");
});

test("bad files give clear errors, not crashes", T, async () => {
  await assert.rejects(run("corrupt.pdf"), (e) => e instanceof AK.KeyExtractError && e.code === "corrupt" && /corrupted|valid PDF/i.test(e.message));
  await assert.rejects(run("not_a_pdf.pdf"), (e) => e.code === "notpdf" && /not a PDF/i.test(e.message));
  await assert.rejects(run("empty.pdf"), (e) => e.code === "empty");
  await assert.rejects(run("encrypted.pdf"), (e) => e.code === "password" && /password/i.test(e.message));
});

test("OCR engine failing to load gives a useful message", T, async () => {
  const failing = () => Promise.reject(new Error("network down"));
  await assert.rejects(
    AK.extractFromPdf(fx("key_scanned.pdf"), { pdfjsLib, createOcr: failing, renderPage }, {}),
    (e) => e.code === "ocr-load" && /internet connection/i.test(e.message)
  );
});

test("OCR is only loaded when needed (text PDFs never touch it)", T, async () => {
  const before = ocrCreated;
  await run("key_text_table.pdf");
  await run("key_text_formats.pdf");
  assert.equal(ocrCreated, before);
});
