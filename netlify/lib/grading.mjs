// Pure grading + validation helpers. No I/O, so they can be unit-tested directly.

export const LETTERS = "ABCDEF";
export const MAX_QUESTIONS = 300;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

const clampOptions = (n) => Math.max(2, Math.min(6, Math.round(Number(n)) || 4));

/**
 * Turn anything into a valid option letter, or null.
 * - trims + upper-cases ("b " -> "B")
 * - must be a single letter A-F
 * - must exist for a question with `optionCount` options (E is invalid for a 4-option question)
 */
export function normalizeOption(value, optionCount = 6) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toUpperCase();
  if (!/^[A-F]$/.test(s)) return null;
  if (LETTERS.indexOf(s) >= clampOptions(optionCount)) return null;
  return s;
}

export const round2 = (x) => Math.round(x * 100) / 100;

/** Validate + sanitise the body of "create exam". Throws ValidationError. */
export function validateExamInput(body) {
  if (!body || typeof body !== "object") throw new ValidationError("Request body must be JSON.");
  const rawQs = body.questions;
  if (!Array.isArray(rawQs) || rawQs.length === 0) throw new ValidationError("Add at least one question.");
  if (rawQs.length > MAX_QUESTIONS) throw new ValidationError(`Too many questions (max ${MAX_QUESTIONS}).`);

  let keyed = 0;
  const questions = rawQs.map((q, i) => {
    const n = i + 1;
    if (!q || typeof q.img !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(q.img))
      throw new ValidationError(`Question ${n}: missing or invalid image.`);
    const options = clampOptions(q.options);
    let correct = null;
    const has = q.correct !== null && q.correct !== undefined && String(q.correct).trim() !== "";
    if (has) {
      correct = normalizeOption(q.correct, options);
      if (!correct) {
        throw new ValidationError(
          `Question ${q.label ? q.label : n}: "${String(q.correct).slice(0, 12)}" is not a valid correct answer ` +
            `for a ${options}-option question (allowed: ${LETTERS.slice(0, options).split("").join(", ")}).`
        );
      }
      keyed++;
    }
    return { img: q.img, label: String(q.label || "").slice(0, 10), options, correct };
  });

  const manualGrading = body.manualGrading === true;
  if (keyed === 0 && !manualGrading) {
    throw new ValidationError(
      "This exam has no valid answer key. Upload and apply an answer key, pick the correct options manually, " +
        'or tick "Create without an answer key (I will grade manually)".'
    );
  }

  // Only a whitelisted summary of how the key was produced is stored (no raw client data).
  const km = body.answerKey && typeof body.answerKey === "object" ? body.answerKey : {};
  const answerKey = {
    source: ["pdf", "manual", "mixed", "none"].includes(km.source) ? km.source : keyed ? "manual" : "none",
    method: ["text", "ocr", "text+ocr"].includes(km.method) ? km.method : null,
    fileName: km.fileName ? String(km.fileName).slice(0, 120) : null,
    detected: Number.isFinite(Number(km.detected)) ? Math.max(0, Math.min(5000, Math.round(Number(km.detected)))) : null,
    keyed, // computed here, never trusted from the client
    total: questions.length,
    confirmedAt: new Date().toISOString(),
  };

  return {
    title: String(body.title || "Untitled exam").slice(0, 120),
    minutes: Math.max(1, Math.min(600, Number(body.minutes) || 30)),
    sheet: body.sheet || null,
    reveal: body.reveal !== false,
    negative: round2(Math.max(0, Math.min(5, Number(body.negative) || 0))),
    grading: keyed > 0 ? "auto" : "manual",
    answerKey,
    questions,
  };
}

/** How many questions of a stored exam have a usable key (tolerates legacy data). */
export function countKeyed(exam) {
  return (exam.questions || []).filter((q) => normalizeOption(q.correct, q.options)).length;
}

/**
 * Grade one submission against the key stored with the exam.
 *
 * Per question (n = position, matching what GET /api/exam/:id sent to the student):
 *   - no valid key              -> "unscored"   (never counted right/wrong, reported separately)
 *   - key, student left blank   -> "unanswered" (never negative-marked)
 *   - key, same letter          -> "correct"    (+1)
 *   - key, different letter     -> "wrong"      (-negative)
 * Grading never looks at exam.reveal; that only controls what the response exposes.
 */
export function gradeSubmission(exam, rawAnswers) {
  const qs = exam.questions || [];
  const src = rawAnswers && typeof rawAnswers === "object" ? rawAnswers : {};
  const negHundredths = Math.round((Number(exam.negative) || 0) * 100);

  const answers = {}; // sanitised copy that gets stored
  let right = 0, wrong = 0, unanswered = 0, notScored = 0;

  const items = qs.map((q, i) => {
    const n = i + 1;
    const yours = normalizeOption(src[n] ?? src[String(n)], q.options);
    if (yours) answers[n] = yours;
    const key = normalizeOption(q.correct, q.options);
    let status;
    if (!key) { status = "unscored"; notScored++; }
    else if (!yours) { status = "unanswered"; unanswered++; }
    else if (yours === key) { status = "correct"; right++; }
    else { status = "wrong"; wrong++; }
    return { n, yours: yours || null, key, status };
  });

  const graded = qs.length - notScored;
  const negativeMarks = (wrong * negHundredths) / 100;
  const score = Math.round(right * 100 - wrong * negHundredths) / 100;

  return {
    answers,
    items,
    total: qs.length,
    graded,
    notScored,
    right,
    wrong,
    unanswered,
    marks: right,
    negative: Number(exam.negative) || 0,
    negativeMarks: round2(negativeMarks),
    score,
    maxScore: graded,
  };
}

/**
 * Shape of the response a student gets. Correct answers (and per-question right/wrong, which
 * would reveal them) appear ONLY when the exam has reveal enabled. Totals are always returned.
 */
export function publicResult(exam, g) {
  const reveal = exam.reveal !== false;
  return {
    scored: g.graded > 0,
    reveal,
    total: g.total,
    graded: g.graded,
    notScored: g.notScored,
    right: g.right,
    wrong: g.wrong,
    unanswered: g.unanswered,
    marks: g.marks,
    negative: g.negative,
    negativeMarks: g.negativeMarks,
    score: g.score,
    maxScore: g.maxScore,
    review: g.items.map((it) =>
      reveal
        ? {
            n: it.n,
            yours: it.yours,
            status: it.status,
            ok: it.status === "correct" ? true : it.status === "wrong" ? false : null,
            correct: it.key,
          }
        : { n: it.n, yours: it.yours }
    ),
    sheet: reveal ? exam.sheet || null : null,
  };
}
