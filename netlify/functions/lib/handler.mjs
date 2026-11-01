import { validateExamInput, gradeSubmission, publicResult, countKeyed, ValidationError } from "./grading.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/* ---- Optional "Detect questions" feature (unchanged; needs ANTHROPIC_API_KEY). ---- */
const PROMPT = `This photo shows several multiple-choice exam questions. Find every separate question.
For each one return:
- "number": its printed serial number exactly as printed (for example "12"), or "" if none is visible
- "box": [x1, y1, x2, y2] as fractions of the image width and height (0 to 1) that contains the WHOLE question: serial number, question text, any figure or table, and all answer options.
Boxes must not overlap other questions. List questions in reading order (if the page has columns: left column top to bottom, then the next column).
Reply with JSON only, no other text: {"questions":[{"number":"1","box":[0.05,0.02,0.95,0.2]}]}`;

async function detect(buf, env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Auto-detect needs ANTHROPIC_API_KEY set in Netlify environment variables.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 3000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(buf).toString("base64") } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || "AI request failed");
  const text = (data.content || []).map((p) => p.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Could not read the AI reply. Try again.");
  const parsed = JSON.parse(m[0]);
  const clamp = (v) => Math.max(0, Math.min(1, Number(v)));
  const out = [];
  for (const q of parsed.questions || []) {
    if (!Array.isArray(q.box) || q.box.length !== 4) continue;
    const [x1, y1, x2, y2] = q.box.map(clamp);
    if (x2 - x1 < 0.03 || y2 - y1 < 0.01) continue;
    out.push({ number: String(q.number || "").slice(0, 10), box: [x1, y1, x2, y2] });
  }
  return out;
}

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

/**
 * Builds the request handler. `getStore` is injected so tests can use an in-memory store;
 * netlify/functions/api.mjs passes the real @netlify/blobs getStore.
 */
export function createHandler({ getStore, env = process.env }) {
  return async (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const exams = getStore("exams");
    const images = getStore("images");
    const results = getStore("results");

    const isAdmin = () => !!env.ADMIN_PASSWORD && req.headers.get("x-admin-password") === env.ADMIN_PASSWORD;
    const [a, b, c] = parts;

    try {
      /* ---------- public ---------- */

      // GET /api/img/:key
      if (req.method === "GET" && a === "img" && b) {
        const data = await images.get(b, { type: "arrayBuffer" });
        if (!data) return new Response("Not found", { status: 404 });
        return new Response(data, {
          headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000" },
        });
      }

      // GET /api/exam/:id  -> NEVER includes correct answers or key metadata
      if (req.method === "GET" && a === "exam" && b) {
        const ex = await exams.get(b, { type: "json" });
        if (!ex) return json({ error: "Exam not found" }, 404);
        return json({
          id: ex.id,
          title: ex.title,
          minutes: ex.minutes,
          negative: ex.negative || 0,
          scored: countKeyed(ex) > 0,
          questions: ex.questions.map((q, i) => ({ n: i + 1, label: q.label || "", img: q.img, options: q.options })),
        });
      }

      // POST /api/submit/:id  -> graded here, from the key persisted with the exam
      if (req.method === "POST" && a === "submit" && b) {
        const ex = await exams.get(b, { type: "json" });
        if (!ex) return json({ error: "Exam not found" }, 404);
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ error: "Invalid submission." }, 400);
        const name = String(body.name || "").slice(0, 80) || "Anonymous";

        const g = gradeSubmission(ex, body.answers);
        const rid = uid();
        await results.setJSON(`${b}/${rid}`, {
          id: rid,
          name,
          score: g.score,
          maxScore: g.maxScore,
          right: g.right,
          wrong: g.wrong,
          unanswered: g.unanswered,
          notScored: g.notScored,
          negativeMarks: g.negativeMarks,
          graded: g.graded,
          total: g.total,
          answers: g.answers,
          at: new Date().toISOString(),
        });
        return json(publicResult(ex, g));
      }

      /* ---------- admin ---------- */

      if (a === "admin") {
        if (!isAdmin()) return json({ error: "Wrong password" }, 401);

        if (b === "login") return json({ ok: true });

        // POST /api/admin/detect  (raw jpeg bytes) -> question boxes
        if (req.method === "POST" && b === "detect") {
          const questions = await detect(await req.arrayBuffer(), env);
          return json({ questions });
        }

        // POST /api/admin/image  (raw jpeg bytes)
        if (req.method === "POST" && b === "image") {
          const key = uid() + uid();
          await images.set(key, await req.arrayBuffer());
          return json({ key });
        }

        // POST /api/admin/exam
        if (req.method === "POST" && b === "exam") {
          const body = await req.json().catch(() => null);
          const fields = validateExamInput(body); // throws ValidationError -> 400
          const id = uid();
          const exam = { id, ...fields, created: new Date().toISOString() };
          await exams.setJSON(id, exam);
          return json({ id, keyed: fields.answerKey.keyed, total: fields.questions.length });
        }

        // GET /api/admin/exams
        if (req.method === "GET" && b === "exams") {
          const { blobs } = await exams.list();
          const all = [];
          for (const { key } of blobs) {
            const ex = await exams.get(key, { type: "json" });
            if (ex)
              all.push({
                id: ex.id,
                title: ex.title,
                minutes: ex.minutes,
                count: ex.questions.length,
                keyed: countKeyed(ex),
                created: ex.created,
              });
          }
          all.sort((x, y) => (y.created || "").localeCompare(x.created || ""));
          return json(all);
        }

        // GET /api/admin/exam/:id  (full exam INCLUDING the answer key; admin only)
        if (req.method === "GET" && b === "exam" && c) {
          const ex = await exams.get(c, { type: "json" });
          if (!ex) return json({ error: "Exam not found" }, 404);
          return json({
            id: ex.id,
            title: ex.title,
            negative: ex.negative || 0,
            reveal: ex.reveal !== false,
            grading: ex.grading || (countKeyed(ex) ? "auto" : "manual"),
            answerKey: ex.answerKey || null,
            keyed: countKeyed(ex),
            questions: ex.questions.map((q, i) => ({ n: i + 1, label: q.label || "", options: q.options, correct: q.correct || null })),
          });
        }

        // GET /api/admin/results/:id
        if (req.method === "GET" && b === "results" && c) {
          const { blobs } = await results.list({ prefix: c + "/" });
          const all = [];
          for (const { key } of blobs) {
            const r = await results.get(key, { type: "json" });
            if (r) all.push(r);
          }
          all.sort((x, y) => (y.at || "").localeCompare(x.at || ""));
          return json(all);
        }

        // DELETE /api/admin/exam/:id
        if (req.method === "DELETE" && b === "exam" && c) {
          const ex = await exams.get(c, { type: "json" });
          if (ex) {
            for (const q of ex.questions) await images.delete(q.img);
            if (ex.sheet) await images.delete(ex.sheet);
          }
          await exams.delete(c);
          const { blobs } = await results.list({ prefix: c + "/" });
          for (const { key } of blobs) await results.delete(key);
          return json({ ok: true });
        }
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof ValidationError) return json({ error: e.message }, 400);
      return json({ error: String(e.message || e) }, 500);
    }
  };
}
