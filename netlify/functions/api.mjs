import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const exams = getStore("exams");
  const images = getStore("images");
  const results = getStore("results");

  const isAdmin = () =>
    !!process.env.ADMIN_PASSWORD &&
    req.headers.get("x-admin-password") === process.env.ADMIN_PASSWORD;

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

    // GET /api/exam/:id  (no answers)
    if (req.method === "GET" && a === "exam" && b) {
      const ex = await exams.get(b, { type: "json" });
      if (!ex) return json({ error: "Exam not found" }, 404);
      return json({
        id: ex.id,
        title: ex.title,
        minutes: ex.minutes,
        negative: ex.negative || 0,
        questions: ex.questions.map((q, i) => ({ n: i + 1, img: q.img, options: q.options })),
      });
    }

    // POST /api/submit/:id
    if (req.method === "POST" && a === "submit" && b) {
      const ex = await exams.get(b, { type: "json" });
      if (!ex) return json({ error: "Exam not found" }, 404);
      const body = await req.json();
      const name = String(body.name || "").slice(0, 80) || "Anonymous";
      const answers = body.answers || {};
      const reveal = ex.reveal !== false;
      let score = 0;
      let graded = 0;
      let right = 0;
      let wrong = 0;
      const neg = Number(ex.negative) || 0;
      const review = ex.questions.map((q, i) => {
        const yours = answers[i + 1] || null;
        if (q.correct) {
          graded++;
          if (yours === q.correct) right++;
          else if (yours) wrong++;
        }
        return {
          n: i + 1,
          yours,
          ok: q.correct ? yours === q.correct : null,
          correct: reveal ? q.correct || null : null,
        };
      });
      score = Math.round((right - wrong * neg) * 100) / 100;
      const rid = uid();
      await results.setJSON(`${b}/${rid}`, {
        id: rid, name, score, right, wrong, graded, total: ex.questions.length,
        answers, at: new Date().toISOString(),
      });
      return json({ score, right, wrong, negative: neg, graded, total: ex.questions.length, review, sheet: reveal ? ex.sheet || null : null });
    }

    /* ---------- admin ---------- */

    if (a === "admin") {
      if (!isAdmin()) return json({ error: "Wrong password" }, 401);

      if (b === "login") return json({ ok: true });

      // POST /api/admin/image  (raw jpeg bytes)
      if (req.method === "POST" && b === "image") {
        const key = uid() + uid();
        await images.set(key, await req.arrayBuffer());
        return json({ key });
      }

      // POST /api/admin/exam
      if (req.method === "POST" && b === "exam") {
        const body = await req.json();
        const id = uid();
        const exam = {
          id,
          title: String(body.title || "Untitled exam").slice(0, 120),
          minutes: Math.max(1, Math.min(600, Number(body.minutes) || 30)),
          sheet: body.sheet || null,
          reveal: body.reveal !== false,
          negative: Math.max(0, Math.min(5, Number(body.negative) || 0)),
          created: new Date().toISOString(),
          questions: (body.questions || []).map((q) => ({
            img: q.img,
            options: Math.max(2, Math.min(6, Number(q.options) || 4)),
            correct: q.correct || null,
          })),
        };
        await exams.setJSON(id, exam);
        return json({ id });
      }

      // GET /api/admin/exams
      if (req.method === "GET" && b === "exams") {
        const { blobs } = await exams.list();
        const all = [];
        for (const { key } of blobs) {
          const ex = await exams.get(key, { type: "json" });
          if (ex) all.push({ id: ex.id, title: ex.title, minutes: ex.minutes, count: ex.questions.length, created: ex.created });
        }
        all.sort((x, y) => (y.created || "").localeCompare(x.created || ""));
        return json(all);
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
    return json({ error: String(e.message || e) }, 500);
  }
};
