// END-TO-END: the real admin.html and index.html run in jsdom, talking to the real backend handler
// (in-memory blobs), using real PDF.js and real Tesseract OCR on the fixture PDFs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHandler } from "../netlify/lib/handler.mjs";
import { memoryStores, client } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
const require = createRequire(import.meta.url);
let JSDOM, pdfjsLib, RealTesseract, langPath, skip = false;
try {
  ({ JSDOM } = require("jsdom"));
  pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
  RealTesseract = require("tesseract.js");
  langPath = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0");
} catch { skip = "heavy test deps not installed (cd tests && npm install)"; }
const T = { skip, timeout: 300000 };

const KEY = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "expected.json"), "utf8")).key;
const fixture = (n) => {
  const buf = fs.readFileSync(path.join(here, "fixtures", n));
  return { name: n, type: "application/pdf", size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 240000) {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + what); await sleep(25); }
}

/** Boots a page. `env` = {handler, fetch}. */
function boot(file, { handler, search = "", login = false, tesseractCalls }) {
  let html = fs.readFileSync(path.join(pub, file), "utf8");
  html = html.replace('<script src="answerkey.js"></script>', "<script>" + fs.readFileSync(path.join(pub, "answerkey.js"), "utf8") + "</script>");
  const dialogs = { alerts: [], confirms: [] };
  const dom = new JSDOM(html, {
    url: "http://localhost/" + file + search, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async (u, o = {}) => handler(new Request(new URL(u, "http://localhost"), o));
      w.alert = (m) => dialogs.alerts.push(String(m));
      w.confirm = (m) => (dialogs.confirms.push(String(m)), true);
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.URL.createObjectURL = () => "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
      w.pdfjsLib = pdfjsLib;
      w.Tesseract = {
        async createWorker(lang, oem, opts) {
          tesseractCalls && tesseractCalls.push(1);
          const wk = await RealTesseract.createWorker(lang, oem, { ...opts, langPath, gzip: true, cachePath: path.join(os.tmpdir(), "tess-cache") });
          return { recognize: (cv) => wk.recognize(Buffer.from(cv.toDataURL("image/png").split(",")[1], "base64")), terminate: () => wk.terminate() };
        },
      };
      if (login) w.sessionStorage.setItem("pw", "pw");
    },
  });
  return { w: dom.window, d: dom.window.document, dialogs, $: (id) => dom.window.document.getElementById(id) };
}

const setup = () => {
  const mem = memoryStores();
  const handler = createHandler({ getStore: mem.getStore, env: { ADMIN_PASSWORD: "pw" } });
  return { mem, handler, api: client(handler) };
};

async function adminReady(env, nQuestions, labelFn = () => "", optionsFn = () => 4) {
  const a = boot("admin.html", { ...env, login: true });
  await until(() => !a.$("panel").classList.contains("hidden"), "admin login");
  a.w.eval("window.__t = { items: () => items, render: () => renderItems() }");
  for (let i = 0; i < nQuestions; i++)
    a.w.__t.items().push({ blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9, i])], { type: "image/jpeg" }), url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", options: optionsFn(i), correct: "", label: labelFn(i) });
  a.w.__t.render();
  return a;
}
const pickFile = (a, id, file) => Object.defineProperty(a.$(id), "files", { value: [file], configurable: true });
async function extract(a, file, opts = {}) {
  pickFile(a, "keyFile", file);
  if (opts.pages) a.$("keyPages").value = opts.pages;
  a.$("keyBtn").click();
  await until(() => !a.$("keyBtn").disabled, "extraction");
}
const tableRows = (a) => [...a.$("keyBody").children].map((tr) => ({
  q: tr.children[0].textContent, answer: tr.querySelector("select").value,
  status: tr.querySelector(".pill").textContent, level: tr.dataset.level, el: tr,
}));
const setSelect = (tr, v) => { const s = tr.querySelector("select"); s.value = v; s.dispatchEvent(new s.ownerDocument.defaultView.Event("change")); };
const adminExam = async (api, id) => (await api.admin("GET", "/api/admin/exam/" + id)).body;
const createdId = (a) => (a.$("created").textContent.match(/exam=(\w+)/) || [])[1];
async function createExam(a) { a.$("createBtn").click(); await until(() => !a.$("createBtn").disabled, "create"); }

/* ------------------------------------------------------------------ */
test("E2E 1: text key PDF -> review -> apply -> create; questions labelled OUT OF ORDER are matched by label", T, async () => {
  const env = setup();
  // upload order is reversed: position 0 holds question 20, ... position 19 holds question 1
  const a = await adminReady(env, 20, (i) => String(20 - i));
  a.$("title").value = "Label matching";
  await extract(a, fixture("key_text_table.pdf"));
  assert.match(a.$("keySummary").textContent, /Detected 20 answers · 20 match exam questions · 20 ready to apply · 20 exam questions/);
  const rows = tableRows(a);
  assert.equal(rows.length, 20);
  assert.ok(rows.every((r) => r.status === "Valid" && r.level === "ok"));
  assert.equal(a.$("keyOcrNote").classList.contains("hidden"), true);          // text PDF: no OCR warning
  assert.ok(![...a.$("keyWarn").querySelectorAll("li")].some((l) => /upload order/.test(l.textContent)));
  // NOT applied until confirmed
  assert.ok(a.w.__t.items().every((it) => it.correct === ""));
  a.$("keyApplyBtn").click();
  assert.equal(a.w.__t.items().filter((it) => it.correct).length, 20);
  assert.ok(a.w.__t.items().every((it) => it.correct === KEY[it.label]), "answers must follow the LABEL, not the position");
  assert.match(a.$("keyCoverage").textContent, /set for 20 of 20/);
  await createExam(a);
  const id = createdId(a); assert.ok(id, a.$("status").textContent);
  const full = await adminExam(env.api, id);
  assert.equal(full.answerKey.source, "pdf"); assert.equal(full.answerKey.fileName, "key_text_table.pdf"); assert.equal(full.answerKey.keyed, 20);
  full.questions.forEach((q) => assert.equal(q.correct, KEY[q.label]));
});

test("E2E 2: SCANNED key PDF -> OCR (loaded only now) -> OCR warning shown -> apply by order -> create", T, async () => {
  const env = setup(); const calls = [];
  const a = await adminReady({ ...env, tesseractCalls: calls }, 20);
  a.$("title").value = "Scanned";
  await extract(a, fixture("key_scanned.pdf"));
  assert.equal(calls.length, 1, "OCR engine created exactly once, only because the PDF needed it");
  assert.equal(a.$("keyOcrNote").classList.contains("hidden"), false);
  assert.match(a.$("keyMsg").textContent, /OCR/);
  assert.ok([...a.$("keyWarn").querySelectorAll("li")].some((l) => /upload order/.test(l.textContent)));
  const rows = tableRows(a);
  for (const r of rows) if (r.status === "Valid") assert.equal(r.answer, KEY[r.q], "a confident OCR answer must be right");
  assert.ok(rows.filter((r) => r.status === "Valid").length >= 18);
  a.$("keyApplyBtn").click();
  a.w.__t.items().forEach((it, i) => { if (it.correct) assert.equal(it.correct, KEY[i + 1]); });
  await createExam(a);
  const full = await adminExam(env.api, createdId(a));
  assert.equal(full.answerKey.method, "ocr");
  assert.ok(full.keyed >= 18);
});

test("E2E 3: missing / invalid / duplicate rows are highlighted, blocked, editable; partial key warns before creating", T, async () => {
  const env = setup();
  const a = await adminReady(env, 20);
  a.$("title").value = "Messy";
  // --- missing (5, 9, 14)
  await extract(a, fixture("key_text_missing.pdf"));
  assert.match(a.$("keySummary").textContent, /Detected 17 answers · 17 match exam questions · 17 ready/);
  let rows = tableRows(a);
  assert.deepEqual(rows.filter((r) => r.status === "Missing").map((r) => r.q), ["5", "9", "14"]);
  assert.ok(rows.filter((r) => r.status === "Missing").every((r) => r.level === "bad" && r.answer === ""));
  assert.ok([...a.$("keyWarn").querySelectorAll("li")].some((l) => /lists 17 question numbers.*exam has 20/.test(l.textContent)));
  // manual entry of one missing answer, with confirmation of the apply dialog
  setSelect(rows.find((r) => r.q === "5").el, "A");
  rows = tableRows(a);
  assert.equal(rows.find((r) => r.q === "5").status, "Valid (edited)");
  // --- only-issues filter
  a.$("keyOnlyIssues").checked = true; a.$("keyOnlyIssues").dispatchEvent(new a.w.Event("change"));
  assert.equal([...a.$("keyBody").children].filter((t) => !t.classList.contains("hidden")).length, 2);
  a.$("keyOnlyIssues").checked = false; a.$("keyOnlyIssues").dispatchEvent(new a.w.Event("change"));
  a.$("keyApplyBtn").click();
  assert.match(a.dialogs.confirms.at(-1), /Apply 18 answers/); assert.match(a.dialogs.confirms.at(-1), /2 questions will still have no correct answer/);
  assert.equal(a.w.__t.items().filter((it) => it.correct).length, 18);
  // --- partial key: creating warns first
  await createExam(a);
  assert.match(a.dialogs.confirms.at(-1), /2 of 20 questions have no correct answer.*NOT scored/s);
  const full = await adminExam(env.api, createdId(a));
  assert.equal(full.keyed, 18); assert.equal(full.questions[8].correct, null); assert.equal(full.questions[13].correct, null);
});

test("E2E 4: duplicate + invalid entries are flagged and NOT applied until the admin resolves them", T, async () => {
  const env = setup();
  const a = await adminReady(env, 20);
  await extract(a, fixture("key_text_duplicates.pdf"));
  let rows = tableRows(a);
  const by = () => Object.fromEntries(tableRows(a).map((r) => [r.q, r]));
  assert.equal(by()["3"].status, "Duplicate (same answer)"); assert.equal(by()["3"].answer, "B");
  assert.equal(by()["7"].status, "Duplicate (conflict)");   assert.equal(by()["7"].answer, "");
  a.$("keyClearBtn").click();                                // discard (confirm auto-yes)
  assert.equal(a.$("keyReview").classList.contains("hidden"), true);

  await extract(a, fixture("key_text_invalid.pdf"));
  const r2 = by();
  assert.equal(r2["4"].status, "Invalid"); assert.equal(r2["8"].status, "Ambiguous"); assert.equal(r2["12"].status, "Ambiguous"); assert.equal(r2["15"].status, "Invalid");
  for (const q of ["4", "8", "12", "15"]) assert.equal(r2[q].level, "bad");
  a.$("keyApplyBtn").click();
  assert.match(a.dialogs.confirms.at(-1), /Apply 16 answers/); assert.match(a.dialogs.confirms.at(-1), /4 invalid, ambiguous, conflicting/);
  const items = a.w.__t.items();
  for (const bad of [4, 8, 12, 15]) assert.equal(items[bad - 1].correct, "", "Q" + bad + " must stay unset");
  // admin fixes Q4 by hand in the review table, applies again
  setSelect(by()["4"].el, "D");
  a.$("keyApplyBtn").click();
  assert.equal(items[3].correct, "D");
});

test("E2E 5: unmatched key numbers are reported; Ignore removes them; first-question offset works", T, async () => {
  const env = setup();
  const a = await adminReady(env, 10);                       // exam has only 10 questions, key has 20
  await extract(a, fixture("key_text_table.pdf"));
  assert.match(a.$("keySummary").textContent, /Detected 20 answers · 10 match exam questions/);
  assert.ok([...a.$("keyWarn").querySelectorAll("li")].some((l) => /Key numbers with no matching exam question: 11, 12/.test(l.textContent)));
  const un = tableRows(a).filter((r) => r.status === "No matching question");
  assert.equal(un.length, 10);
  un[0].el.querySelector("button").click();
  assert.equal(tableRows(a).filter((r) => r.status === "No matching question").length, 9);
  // key numbers 11-20 belong to these 10 questions: first-question offset = 11
  a.$("keyOffset").value = "11"; a.$("keyOffset").dispatchEvent(new a.w.Event("input"));
  a.$("keyApplyBtn").click();
  a.w.__t.items().forEach((it, i) => assert.equal(it.correct, KEY[11 + i]));
});

test("E2E 6: bad files and missing prerequisites give clear messages", T, async () => {
  const env = setup();
  const a = await adminReady(env, 3);
  const msg = () => a.$("keyErr").textContent;
  a.$("keyBtn").click(); await sleep(20); assert.match(msg(), /Choose the answer-key PDF first/);
  await extract(a, { name: "notes.txt", type: "text/plain", size: 10, arrayBuffer: async () => new ArrayBuffer(10) }); assert.match(msg(), /not a PDF/);
  await extract(a, fixture("not_a_pdf.pdf")); assert.match(msg(), /not a PDF/);
  await extract(a, fixture("corrupt.pdf")); assert.match(msg(), /corrupted|valid PDF/i);
  await extract(a, fixture("encrypted.pdf")); assert.match(msg(), /password/i);
  await extract(a, fixture("empty.pdf")); assert.match(msg(), /empty/i);
  await extract(a, fixture("key_text_table.pdf"), { pages: "abc" }); assert.match(msg(), /page range/i);
  assert.equal(a.$("keyReview").classList.contains("hidden"), true);
  assert.equal(a.$("keyBtn").disabled, false);                     // UI recovered after each failure
  const b = await adminReady(setup(), 0);
  await extract(b, fixture("key_text_table.pdf")); assert.match(b.$("keyErr").textContent, /Add the question photos first/);
});

test("E2E 7: cannot create an exam without a key unless 'create without answer key' is ticked", T, async () => {
  const env = setup();
  const a = await adminReady(env, 3);
  a.$("title").value = "No key";
  a.$("createBtn").click(); await sleep(50);
  assert.match(a.dialogs.alerts.at(-1), /no answer key/i);
  assert.equal(createdId(a), undefined);
  assert.equal((await env.api.admin("GET", "/api/admin/exams")).body.length, 0);   // nothing was uploaded/created
  a.$("manualGrade").checked = true;
  await createExam(a);
  const id = createdId(a); assert.ok(id);
  const full = await adminExam(env.api, id);
  assert.equal(full.grading, "manual"); assert.equal(full.keyed, 0);
  const sub = await env.api.pub("POST", "/api/submit/" + id, { name: "x", answers: { 1: "A" } });
  assert.equal(sub.body.scored, false);
});

test("E2E 8: extracted-but-unapplied answers trigger a warning at create time", T, async () => {
  const env = setup();
  const a = await adminReady(env, 20);
  a.$("title").value = "Forgot to apply";
  await extract(a, fixture("key_text_table.pdf"));
  a.w.__t.items()[0].correct = "A"; a.w.__t.render();            // one manual pick so creation is otherwise allowed
  await createExam(a);
  assert.match(a.dialogs.confirms.at(-1), /extracted answers.*not applied/s);
});

/* ------------------------------------------------------------------ */
async function makeExam(env, { negative, reveal, correct = ["A", "B", "C", "D"] }) {
  const a = await adminReady(env, correct.length);
  a.w.__t.items().forEach((it, i) => (it.correct = correct[i])); a.w.__t.render();
  a.$("title").value = "Student test"; a.$("reveal").checked = reveal;
  if (negative) { a.$("negOn").checked = true; a.$("negOn").dispatchEvent(new a.w.Event("change")); a.$("negVal").value = String(negative); }
  await createExam(a);
  return createdId(a);
}
async function takeExam(env, id, picks) {
  const s = boot("index.html", { ...env, search: "?exam=" + id });
  await until(() => !s.$("start").classList.contains("hidden"), "student start page");
  s.$("name").value = "Student";
  s.$("startBtn").click();
  for (const [n, letter] of Object.entries(picks)) {
    const inp = s.d.querySelector(`input[name="q${n}"][value="${letter}"]`);
    inp.checked = true; inp.dispatchEvent(new s.w.Event("change"));
  }
  s.$("submitBtn").click();
  await until(() => !s.$("result").classList.contains("hidden"), "result page");
  const stats = Object.fromEntries([...s.d.querySelectorAll(".stat")].map((e) => [e.lastChild.textContent, e.querySelector("b").textContent]));
  return { s, stats, text: s.$("result").textContent };
}

test("E2E 9: student result with negative marking + reveal ON shows full breakdown and the correct answers", T, async () => {
  const env = setup();
  const id = await makeExam(env, { negative: 0.25, reveal: true });
  const { s, stats, text } = await takeExam(env, id, { 1: "A", 2: "D", 4: "D" });   // right, wrong, blank, right
  assert.deepEqual(stats, { "Total questions": "4", Correct: "2", Incorrect: "1", Unanswered: "1", "Marks obtained": "2", "Negative marks deducted": "−0.25", "Final score": "1.75" });
  assert.equal(s.$("scoreTxt").textContent, "1.75 / 4");
  assert.match(text, /✓ Correct — your answer: A/); assert.match(text, /✗ Wrong — your answer: D · correct: B/); assert.match(text, /Not answered · correct: C/);
  assert.equal(s.d.querySelectorAll(".opt.right").length, 4);            // one highlighted correct option per question
  assert.equal(s.d.querySelectorAll(".opt.wrong").length, 1);
});

test("E2E 10: reveal OFF — still graded with the same numbers, but no correct answers or per-question verdicts", T, async () => {
  const env = setup();
  const id = await makeExam(env, { negative: 0.25, reveal: false });
  const { s, stats, text } = await takeExam(env, id, { 1: "A", 2: "D", 4: "D" });
  assert.deepEqual(stats, { "Total questions": "4", Correct: "2", Incorrect: "1", Unanswered: "1", "Marks obtained": "2", "Negative marks deducted": "−0.25", "Final score": "1.75" });
  assert.doesNotMatch(text, /correct:|✓|✗|Wrong —/);
  assert.match(text, /Your answer: A/); assert.match(text, /Not answered/);
  assert.equal(s.d.querySelectorAll(".opt.right, .opt.wrong").length, 0);
  assert.equal(s.$("sheetCard").classList.contains("hidden"), true);
});

test("E2E 11: manual-grading exam shows 'Submitted' and no score; partially keyed exam says what was not scored", T, async () => {
  const env = setup();
  const a = await adminReady(env, 3); a.$("title").value = "m"; a.$("manualGrade").checked = true; await createExam(a);
  const m = await takeExam(env, createdId(a), { 1: "A", 2: "B" });
  assert.equal(m.s.$("scoreTxt").textContent, "Submitted");
  assert.deepEqual(m.stats, { "Total questions": "3", Answered: "2", Unanswered: "1" });
  const id2 = await makeExam(env, { negative: 0, reveal: true, correct: ["A", "B", null, "D"] });
  const p = await takeExam(env, id2, { 1: "A", 2: "A", 3: "C" });
  assert.equal(p.s.$("scoreTxt").textContent, "1 / 3");
  assert.equal(p.stats["Not scored"], "1");
  assert.match(p.s.$("notScoredNote").textContent, /1 question was not scored.*out of 3/);
});

test("E2E 12: exam data & key persist: reload exams list in a fresh admin page and a fresh server instance", T, async () => {
  const env = setup();
  const id = await makeExam(env, { negative: 0, reveal: true });
  const handler2 = createHandler({ getStore: env.mem.getStore, env: { ADMIN_PASSWORD: "pw" } });    // "server restart"
  const a2 = boot("admin.html", { handler: handler2, login: true });                               // "page reload"
  await until(() => a2.$("exams").textContent.includes("Student test"), "exam list after reload");
  assert.match(a2.$("exams").textContent, /4 questions.*answer key complete/);
  a2.d.querySelector("[data-key]").click();
  await until(() => !a2.d.querySelector("[data-keyline]").classList.contains("hidden"), "key line");
  assert.match(a2.d.querySelector("[data-keyline]").textContent, /1:A\s+2:B\s+3:C\s+4:D/);
  const r = await takeExam({ handler: handler2 }, id, { 1: "A", 2: "B", 3: "C", 4: "D" });         // new student session
  assert.equal(r.s.$("scoreTxt").textContent, "4 / 4");
  a2.d.querySelector("[data-res]").click();
  await until(() => a2.$("resBody").children.length === 1, "results table");
  assert.match(a2.$("resBody").textContent, /Student4 \/ 4400/);
});
