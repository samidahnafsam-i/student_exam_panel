// End-to-end tests of the real request handler (netlify/lib/handler.mjs) against an in-memory blob store.
import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../netlify/lib/handler.mjs";
import { memoryStores, client, q } from "./helpers.mjs";

const env = { ADMIN_PASSWORD: "pw" };
function setup() {
  const mem = memoryStores();
  const c = client(createHandler({ getStore: mem.getStore, env }));
  return { mem, c };
}
const make = async (c, over = {}) => {
  const r = await c.admin("POST", "/api/admin/exam", {
    title: "T", minutes: 10, reveal: true, negative: 0,
    questions: [q("A"), q("B"), q("C"), q("D")], ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
};
const submit = (c, id, answers, name = "Stu") => c.pub("POST", "/api/submit/" + id, { name, answers });

/* ---------------- create-exam validation ---------------- */
test("rejects an invalid correct answer instead of saving it", async () => {
  const { c } = setup();
  const r = await c.admin("POST", "/api/admin/exam", { questions: [q("A"), q("E")] }); // E not valid for 4 options
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Question 2.*"E".*4-option/);
  const z = await c.admin("POST", "/api/admin/exam", { questions: [q("Z")] });
  assert.equal(z.status, 400);
  const multi = await c.admin("POST", "/api/admin/exam", { questions: [q("AB")] });
  assert.equal(multi.status, 400);
});

test("normalises key case/whitespace and accepts E/F when the question has those options", async () => {
  const { c } = setup();
  const id = await make(c, { questions: [q(" b "), q("e", { options: 5 }), q("F", { options: 6 })] });
  const full = (await c.admin("GET", "/api/admin/exam/" + id)).body;
  assert.deepEqual(full.questions.map((x) => x.correct), ["B", "E", "F"]);
});

test("no valid key -> refused, unless the admin explicitly chose manual grading", async () => {
  const { c } = setup();
  const none = await c.admin("POST", "/api/admin/exam", { questions: [q(null), q("")] });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /no valid answer key/i);
  const manual = await c.admin("POST", "/api/admin/exam", { questions: [q(null), q(null)], manualGrading: true });
  assert.equal(manual.status, 200);
  const full = (await c.admin("GET", "/api/admin/exam/" + manual.body.id)).body;
  assert.equal(full.grading, "manual"); assert.equal(full.keyed, 0);
});

test("partial key is allowed and recorded (client warns; server never fakes the rest)", async () => {
  const { c } = setup();
  const id = await make(c, { questions: [q("A"), q(null), q("C")] });
  const full = (await c.admin("GET", "/api/admin/exam/" + id)).body;
  assert.equal(full.keyed, 2); assert.equal(full.answerKey.total, 3); assert.equal(full.grading, "auto");
});

test("other validation: empty question list, bad image key, bad JSON", async () => {
  const { c } = setup();
  assert.equal((await c.admin("POST", "/api/admin/exam", { questions: [] })).status, 400);
  assert.equal((await c.admin("POST", "/api/admin/exam", { questions: [{ img: "../x", options: 4, correct: "A" }] })).status, 400);
  assert.equal((await c.admin("POST", "/api/admin/exam", "{not json")).status, 400);
});

test("answer-key metadata is whitelisted and the keyed count is computed server-side", async () => {
  const { c } = setup();
  const id = await make(c, { answerKey: { source: "pdf", method: "ocr", fileName: "key.pdf", detected: 4, keyed: 999, evil: "<script>" } });
  const k = (await c.admin("GET", "/api/admin/exam/" + id)).body.answerKey;
  assert.equal(k.source, "pdf"); assert.equal(k.method, "ocr"); assert.equal(k.keyed, 4); assert.equal(k.evil, undefined);
});

/* ---------------- admin / public separation ---------------- */
test("admin endpoints need the password; the key is never in public responses", async () => {
  const { c } = setup();
  const id = await make(c);
  assert.equal((await c.pub("GET", "/api/admin/exam/" + id)).status, 401);
  assert.equal((await c.pub("GET", "/api/admin/exams")).status, 401);
  assert.equal((await c.pub("POST", "/api/admin/exam", { questions: [q("A")] })).status, 401);
  const pubExam = await c.pub("GET", "/api/exam/" + id);
  assert.equal(pubExam.status, 200);
  assert.doesNotMatch(pubExam.text, /correct|answerKey|"grading"/i);
  assert.equal(pubExam.body.questions.length, 4);
  assert.equal(pubExam.body.scored, true);
});

/* ---------------- grading ---------------- */
test("correct / incorrect / unanswered counts and marks (no negative marking)", async () => {
  const { c } = setup();
  const id = await make(c);                           // key A B C D
  const r = (await submit(c, id, { 1: "A", 2: "C", 4: "D" })).body; // Q1 right, Q2 wrong, Q3 blank, Q4 right
  assert.deepEqual([r.total, r.right, r.wrong, r.unanswered, r.notScored], [4, 2, 1, 1, 0]);
  assert.deepEqual([r.marks, r.negativeMarks, r.score, r.maxScore], [2, 0, 2, 4]);
});

test("negative marking: only wrong answers lose marks, blanks never do", async () => {
  const { c } = setup();
  const id = await make(c, { negative: 0.25 });
  const r = (await submit(c, id, { 1: "A", 2: "A", 3: "A" })).body; // 1 right, 2 wrong, 1 blank
  assert.deepEqual([r.right, r.wrong, r.unanswered], [1, 2, 1]);
  assert.equal(r.negativeMarks, 0.5);
  assert.equal(r.score, 0.5);
  const blank = (await submit(c, id, {})).body;
  assert.deepEqual([blank.right, blank.wrong, blank.unanswered, blank.score, blank.negativeMarks], [0, 0, 4, 0, 0]);
  const allWrong = (await submit(c, id, { 1: "B", 2: "C", 3: "D", 4: "A" })).body;
  assert.equal(allWrong.score, -1);                         // 4 wrong x 0.25, existing behaviour: no floor at zero
});

test("floating point: 0.05 per wrong answer stays exact", async () => {
  const { c } = setup();
  const id = await make(c, { negative: 0.05, questions: Array.from({ length: 10 }, () => q("A")) });
  const r = (await submit(c, id, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, i < 7 ? "B" : "A"])))).body;
  assert.equal(r.wrong, 7); assert.equal(r.negativeMarks, 0.35); assert.equal(r.score, 2.65);
});

test("grading is case-insensitive for student input and ignores junk answers", async () => {
  const { c } = setup();
  const id = await make(c, { negative: 1 });
  const r = (await submit(c, id, { 1: "a", 2: "Z", 3: "AB", 99: "A", 4: 5 })).body;
  assert.deepEqual([r.right, r.wrong, r.unanswered], [1, 0, 3]);   // junk = unanswered, not wrong
  const stored = (await c.admin("GET", "/api/admin/results/" + (await id))).body[0];
  assert.deepEqual(stored.answers, { 1: "A" });
});

test("questions without a key are reported as not scored, never right/wrong", async () => {
  const { c } = setup();
  const id = await make(c, { negative: 1, questions: [q("A"), q(null), q("C")] });
  const r = (await submit(c, id, { 1: "A", 2: "B", 3: "D" })).body;
  assert.deepEqual([r.total, r.graded, r.notScored, r.right, r.wrong, r.unanswered], [3, 2, 1, 1, 1, 0]);
  assert.deepEqual([r.score, r.maxScore], [0, 2]);                  // 1 right - 1 wrong; the unkeyed answer neither helps nor hurts
});

test("manual-grading exam: answers recorded, nothing scored", async () => {
  const { c } = setup();
  const m = await c.admin("POST", "/api/admin/exam", { questions: [q(null), q(null)], manualGrading: true });
  const r = (await submit(c, m.body.id, { 1: "A", 2: "B" })).body;
  assert.equal(r.scored, false); assert.equal(r.graded, 0); assert.equal(r.notScored, 2); assert.equal(r.score, 0);
  const res = (await c.admin("GET", "/api/admin/results/" + m.body.id)).body;
  assert.deepEqual(res[0].answers, { 1: "A", 2: "B" });
});

/* ---------------- reveal vs grading are independent ---------------- */
test("reveal OFF: still graded, but no correct answers / per-question marks / answer sheet are sent", async () => {
  const { c } = setup();
  const id = await make(c, { reveal: false, sheet: "sheetkey123", negative: 0.5 });
  const res = await submit(c, id, { 1: "A", 2: "A" });
  const r = res.body;
  assert.deepEqual([r.right, r.wrong, r.unanswered, r.score, r.reveal], [1, 1, 2, 0.5, false]);
  assert.equal(r.sheet, null);
  for (const row of r.review) assert.deepEqual(Object.keys(row).sort(), ["n", "yours"]);
  assert.doesNotMatch(res.text, /"correct"|"ok"|"status"/);
});

test("reveal ON: correct answers, the student's choice and per-question status are returned", async () => {
  const { c } = setup();
  const id = await make(c, { reveal: true, sheet: "sheetkey123" });
  const r = (await submit(c, id, { 1: "A", 2: "D" })).body;
  assert.equal(r.sheet, "sheetkey123");
  assert.deepEqual(r.review.map((x) => [x.n, x.yours, x.correct, x.status]),
    [[1, "A", "A", "correct"], [2, "D", "B", "wrong"], [3, null, "C", "unanswered"], [4, null, "D", "unanswered"]]);
});

test("reveal default stays ON for exams that never set it (old data)", async () => {
  const { c, mem } = setup();
  await mem.getStore("exams").setJSON("old1", { id: "old1", title: "old", minutes: 5, negative: 0, questions: [{ img: "a", options: 4, correct: "A" }] });
  const r = (await submit(c, "old1", { 1: "A" })).body;
  assert.equal(r.reveal, true); assert.equal(r.right, 1);
});

/* ---------------- persistence & legacy data ---------------- */
test("key survives a 'cold start': a brand-new handler over the same storage grades correctly", async () => {
  const { c, mem } = setup();
  const id = await make(c, { negative: 0.25 });
  const c2 = client(createHandler({ getStore: mem.getStore, env }));              // new instance = new server process / new student session
  assert.equal((await c2.pub("GET", "/api/exam/" + id)).status, 200);
  const r = (await submit(c2, id, { 1: "A", 2: "B", 3: "C", 4: "A" })).body;
  assert.deepEqual([r.right, r.wrong, r.score], [3, 1, 2.75]);
  const list = (await c2.admin("GET", "/api/admin/exams")).body;
  assert.deepEqual([list[0].count, list[0].keyed], [4, 4]);
});

test("legacy exams: lower-case keys work, impossible keys are 'not scored' (the original bug)", async () => {
  const { c, mem } = setup();
  // exactly what the ORIGINAL backend would have saved for [A, 'b', 'E' on 4 options, no key]
  await mem.getStore("exams").setJSON("legacy", {
    id: "legacy", title: "L", minutes: 5, negative: 0.25, reveal: false,
    questions: [{ img: "a", options: 4, correct: "A" }, { img: "b", options: 4, correct: "b" }, { img: "c", options: 4, correct: "E" }, { img: "d", options: 4, correct: null }],
  });
  const r = (await submit(c, "legacy", { 1: "A", 2: "B" })).body;
  assert.deepEqual([r.right, r.wrong, r.unanswered, r.notScored, r.graded], [2, 0, 0, 2, 2]);
  assert.equal(r.score, 2);                                                   // old code gave 0.75 (B marked wrong)
});

test("submit: unknown exam 404, bad body 400", async () => {
  const { c } = setup();
  assert.equal((await submit(c, "nope", {})).status, 404);
  const id = await make(c);
  assert.equal((await c.pub("POST", "/api/submit/" + id, "not json")).status, 400);
});

test("results list carries the full breakdown; delete removes exam + results", async () => {
  const { c } = setup();
  const id = await make(c, { negative: 0.25 });
  await submit(c, id, { 1: "A", 2: "C" }, "Ann");
  const rs = (await c.admin("GET", "/api/admin/results/" + id)).body;
  assert.equal(rs.length, 1);
  assert.deepEqual([rs[0].name, rs[0].right, rs[0].wrong, rs[0].unanswered, rs[0].score, rs[0].maxScore], ["Ann", 1, 1, 2, 0.75, 4]);
  await c.admin("DELETE", "/api/admin/exam/" + id);
  assert.equal((await c.pub("GET", "/api/exam/" + id)).status, 404);
  assert.equal((await c.admin("GET", "/api/admin/results/" + id)).body.length, 0);
});
