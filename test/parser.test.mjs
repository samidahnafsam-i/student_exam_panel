// Unit tests for public/answerkey.js (no dependencies):  node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import "../public/answerkey.js";
const AK = globalThis.AnswerKey;

const parse = (text) => AK.parseLines(text.split("\n"));
const map = (text) => Object.fromEntries(parse(text).entries.map((e) => [e.q, e.status === "valid" ? e.answer : e.status]));

test("every format named in the spec", () => {
  assert.deepEqual(map("1. A"), { 1: "A" });
  assert.deepEqual(map("1. B, 2. C, 3. D"), { 1: "B", 2: "C", 3: "D" });
  assert.deepEqual(map("Q1: A"), { 1: "A" });
  assert.deepEqual(map("Question 1 - Answer: B"), { 1: "B" });
  assert.deepEqual(map("1 - C"), { 1: "C" });
  assert.deepEqual(map("1 | D"), { 1: "D" });
});

test("other common variations", () => {
  assert.deepEqual(map("1) a\n2) (b)\n3: [c]\n4 = D\n5 – E\n6 — f"), { 1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F" });
  assert.deepEqual(map("Q.7 Ans. B\nQ 8) C\nQn 9: D\nques. 10 answer: a"), { 7: "B", 8: "C", 9: "D", 10: "A" });
  assert.deepEqual(map("1.A 2.B 3.C"), { 1: "A", 2: "B", 3: "C" });
  assert.deepEqual(map("1-A, 2-B; 3-C"), { 1: "A", 2: "B", 3: "C" });
  assert.deepEqual(map("(1) A   (2) B"), { 1: "A", 2: "B" });
  assert.deepEqual(map("11 A 12 B 13 C"), { 11: "A", 12: "B", 13: "C" });          // bare, table-like
  assert.deepEqual(map("  14 .   d  \n\n\n  15\t-\tC"), { 14: "D", 15: "C" });     // spaces, blank lines, tabs
  assert.deepEqual(map("1. B. Because force equals mass times acceleration"), { 1: "B" }); // answer + explanation
  assert.deepEqual(map("Ｑ１：Ａ"), { 1: "A" });                                         // full-width characters
  assert.deepEqual(map("16 - A 17 - B"), { 16: "A", 17: "B" });
});

test("compact tokens and grid layouts", () => {
  assert.deepEqual(map("1A 2B 3C\n4D 5A 6B"), { 1: "A", 2: "B", 3: "C", 4: "D", 5: "A", 6: "B" });
  assert.deepEqual(map("Q.No 1 2 3 4 5\nAns A B C D A"), { 1: "A", 2: "B", 3: "C", 4: "D", 5: "A" });
  assert.deepEqual(map("1 2 3\nB, C, D"), { 1: "B", 2: "C", 3: "D" });
});

test("grid with mismatched counts is NOT guessed", () => {
  const r = parse("1 2 3 4 5\nA B C D");
  assert.equal(r.entries.length, 0);
  assert.equal(r.warnings.length, 1);
});

test("invalid / ambiguous answers are flagged, never converted", () => {
  const r = parse("1. G\n2. Z\n3. AB\n4. A/C\n5. B or D\n6. A, B");
  const by = Object.fromEntries(r.entries.map((e) => [e.q, e]));
  assert.equal(by[1].status, "invalid");
  assert.equal(by[2].status, "invalid");
  assert.equal(by[3].status, "ambiguous");  assert.deepEqual(by[3].candidates, ["A", "B"]);
  assert.equal(by[4].status, "ambiguous");  assert.deepEqual(by[4].candidates, ["A", "C"]);
  assert.equal(by[5].status, "ambiguous");  assert.deepEqual(by[5].candidates, ["B", "D"]);
  assert.equal(by[6].status, "ambiguous");
  for (const e of r.entries) assert.equal(e.answer, null);
});

test("sentences, headings and noise do not create answers", () => {
  assert.deepEqual(map("Physics Quiz 1 - Answer Key"), {});
  assert.deepEqual(map("Page 1 of 3"), {});
  assert.deepEqual(map("1. A man walks into a bar"), {});
  assert.deepEqual(map("Note 5 marks each, 2 hours total"), {});
  assert.deepEqual(map("Total 20 questions, 2023 edition"), {});
  assert.deepEqual(map("3. Bad things happen when 4. Dead ends"), {});
  assert.deepEqual(map("Table 2A shows the results"), {});
  assert.deepEqual(map("1.5 metres"), {});
});

test("number and answer on different lines (last resort, flagged weak)", () => {
  const r = parse("1\nA\n2\nB\n3\nC");
  assert.equal(r.entries.length, 3);
  assert.ok(r.entries.every((e) => e.weak));
  const c = AK.consolidate(r.entries);
  assert.ok(c.every((x) => x.status === "review"));
});

test("duplicates: same answer -> duplicate; different -> conflict with NO answer", () => {
  const c = AK.consolidate(parse("1. A\n2. B\n2. B\n3. C\n3. D\n4. E").entries);
  const by = Object.fromEntries(c.map((x) => [x.q, x]));
  assert.equal(by[1].status, "valid");
  assert.equal(by[2].status, "duplicate"); assert.equal(by[2].answer, "B");
  assert.equal(by[3].status, "conflict");  assert.equal(by[3].answer, ""); assert.deepEqual(by[3].candidates, ["C", "D"]);
  assert.equal(by[4].status, "valid");
});

test("low-confidence OCR lines become 'review'", () => {
  const r = AK.parseLines([{ text: "1. A", conf: 96 }, { text: "2. B", conf: 40 }]);
  const c = AK.consolidate(r.entries);
  assert.equal(c[0].status, "valid");
  assert.equal(c[1].status, "review");
  assert.equal(c[1].answer, "B");
});

test("pageItemsToLines joins table cells on one row and keeps rows apart", () => {
  const it = (str, x, y, w = 8) => ({ str, transform: [10, 0, 0, 10, x, y], width: w, height: 10 });
  const lines = AK.pageItemsToLines([it("A", 200, 700), it("1", 50, 700.4), it("11", 300, 700), it("C", 400, 700), it("2", 50, 685), it("B", 200, 685)]);
  assert.deepEqual(lines, ["1 A 11 C", "2 B"]);
  const split = AK.pageItemsToLines([it("Que", 10, 500, 20), it("stion ", 30, 500, 25), it("1 - Answer: ", 56, 500, 60), it("B", 120, 500, 6)]);
  assert.deepEqual(split, ["Question 1 - Answer: B"]);
});

/* ---------------- matching ---------------- */
const items = (n, extra) => Array.from({ length: n }, (_, i) => Object.assign({ label: "", options: 4 }, extra && extra(i)));
const rowsFor = (text, its, opts) => AK.buildRows(AK.consolidate(parse(text).entries), its, opts);

test("order fallback when no labels", () => {
  const { rows, summary } = rowsFor("1. A\n2. B\n3. C", items(3));
  assert.deepEqual(rows.map((r) => [r.q, r.itemIndex, r.answer, r.canApply]), [[1, 0, "A", true], [2, 1, "B", true], [3, 2, "C", true]]);
  assert.ok(summary.warnings.some((w) => /upload order/.test(w)));
});

test("explicit labels win over upload order", () => {
  // exam uploaded out of order: positions hold questions 3,1,2
  const its = items(3, (i) => ({ label: ["3", "1", "2"][i] }));
  const { rows, summary } = rowsFor("1. A\n2. B\n3. C", its);
  const applied = Object.fromEntries(AK.applyRows(rows).map((a) => [a.index, a.answer]));
  assert.deepEqual(applied, { 0: "C", 1: "A", 2: "B" });  // position0 (label 3) = C, NOT A
  assert.ok(!summary.warnings.some((w) => /upload order/.test(w)));
});

test("labels like 'Q5' and '5.' count as 5", () => {
  const its = items(2, (i) => ({ label: ["Q5", "6."][i] }));
  const { rows } = rowsFor("5. A\n6. D", its);
  assert.deepEqual(AK.applyRows(rows), [{ index: 0, answer: "A" }, { index: 1, answer: "D" }]);
});

test("unmatched key numbers, missing answers and count mismatch are reported", () => {
  const { rows, summary } = rowsFor("1. A\n2. B\n9. C", items(3));
  const by = Object.fromEntries(rows.map((r) => [r.q, r]));
  assert.equal(by[9].status, "unmatched");  assert.equal(by[9].canApply, false);
  assert.equal(by[3].status, "missing");
  assert.equal(summary.detected, 3); assert.equal(summary.examQuestions, 3);
  assert.equal(summary.matched, 2); assert.equal(summary.unmatched, 1); assert.equal(summary.missing, 1);
  assert.deepEqual(AK.applyRows(rows).map((a) => a.index), [0, 1]);

  const m = rowsFor("1. A\n2. B", items(5));
  assert.ok(m.summary.warnings.some((w) => /lists 2 question numbers.*exam has 5/.test(w)));
});

test("invalid, ambiguous and conflicting entries are never applied; edits unblock them", () => {
  const text = "1. A\n2. G\n3. A/B\n4. A\n4. C";
  const { rows } = rowsFor(text, items(4));
  assert.deepEqual(AK.applyRows(rows).map((a) => a.index), [0]);
  const fixed = rowsFor(text, items(4), { edits: { 2: "B", 3: "C", 4: "D" } });
  assert.deepEqual(AK.applyRows(fixed.rows).map((a) => a.answer), ["A", "B", "C", "D"]);
  assert.ok(fixed.rows.filter((r) => r.edited).every((r) => r.status === "valid"));
});

test("answer outside the question's option count is flagged 'range' and blocked", () => {
  const its = items(2, (i) => ({ options: i === 0 ? 4 : 5 }));
  const { rows } = rowsFor("1. E\n2. E", its);
  assert.equal(rows[0].status, "range"); assert.equal(rows[0].canApply, false);
  assert.equal(rows[1].status, "valid");
});

test("duplicate exam labels and non-numeric labels are flagged, not guessed", () => {
  const its = items(3, (i) => ({ label: ["5", "5", "7a"][i] }));
  const { rows } = rowsFor("5. A\n6. B", its);
  const by = Object.fromEntries(rows.map((r) => [String(r.q), r]));
  assert.equal(by["5"].status, "labelclash"); assert.equal(by["5"].canApply, false);
  assert.ok(rows.some((r) => r.status === "nolabel"));
  assert.equal(AK.applyRows(rows).length, 0);
});

test("unlabeled question whose position number is taken by a label is not silently matched", () => {
  const its = items(3, (i) => ({ label: i === 0 ? "2" : "" }));           // pos1 label "2"; pos2 unlabeled -> would be #2
  const { rows } = rowsFor("1. A\n2. B\n3. C", its);
  const by = Object.fromEntries(rows.filter((r) => r.q != null).map((r) => [r.q, r]));
  assert.equal(by[2].itemIndex, 0);                                      // label 2 owns key 2
  assert.ok(rows.some((r) => r.status === "nolabel" && r.itemIndex === 1));
});

test("offset for order-based matching (key starts at 51)", () => {
  const { rows } = rowsFor("51. A\n52. B", items(2), { offset: 51 });
  assert.deepEqual(AK.applyRows(rows), [{ index: 0, answer: "A" }, { index: 1, answer: "B" }]);
  const none = rowsFor("51. A\n52. B", items(2));                         // default offset 1 -> loud failure, not a guess
  assert.equal(AK.applyRows(none.rows).length, 0);
  assert.equal(none.summary.unmatched, 2);
});

test("OCR dropped full stop ('5A') is accepted only inside an otherwise clean line", () => {
  assert.deepEqual(map("5A 15.D"), { 5: "A", 15: "D" });
  assert.deepEqual(map("Table 2A shows 3.B"), { 3: "B" });            // prose "2A" must not match
});

test("per-word OCR confidence: a shaky neighbour does not taint a clear answer", () => {
  const w = (text, conf) => ({ text, conf });
  const line = { text: "1. A 11.C", conf: 34, words: [w("1.", 5), w("A", 5), w("11.C", 92)] };
  const c = Object.fromEntries(AK.consolidate(AK.parseLines([line]).entries).map((x) => [x.q, x.status]));
  assert.deepEqual(c, { 1: "review", 11: "valid" });
});
