// Generates per-question "why is this the answer" explanations for standalone
// Reading tests, quoting real evidence from the passage rather than a generic
// "how to approach True/False/Not Given" tip.
//
// These test files are static HTML with the passage text and answer key
// embedded as plain JS data literals (not rendered by a framework, not fetched
// from anywhere) -- so both can be read straight out of the file text without
// executing any of the page's script. Different tests name the question-prompt
// object differently (`q`, `qdata`, ...), so instead of guessing a name, this
// looks for the shape that actually carries a prompt: a `[questionNumber,
// "prompt text"]` pair. That shape is unambiguous regardless of what object it
// sits inside, which is what makes this safe to run across tests nobody has
// looked at individually -- the pattern being absent just means that question
// keeps the generic fallback tip, not that anything gets mismatched.
//
// Question types that don't take this shape (heading lists, note/gap-fill
// completion, multiple choice) are deliberately left uncovered here rather
// than guessed at -- a wrong "how it works" is invisible to skim past, but a
// wrong "evidence" quote actively misleads a student studying from it.

function safeJsonLiteral(html, varName) {
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*(\\{[\\s\\S]*?\\});`);
  const match = html.match(re);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

export function extractReadingContent(html) {
  const passages = safeJsonLiteral(html, 'passages');
  const answerKey = safeJsonLiteral(html, 'answerKey');
  if (!passages || !answerKey) return null;

  // partData carries `range:[start,end]` once per passage part, in part order
  // (1, 2, 3, ...) -- pull every occurrence rather than the object name, since
  // that's the same variable-name-agnostic reasoning as the prompt-pair scan.
  const partRanges = [];
  const rangeRe = /range\s*:\s*\[(\d+)\s*,\s*(\d+)\]/g;
  let rm;
  while ((rm = rangeRe.exec(html))) partRanges.push([Number(rm[1]), Number(rm[2])]);
  if (!partRanges.length) return null;

  const qNums = new Set(Object.keys(answerKey).map(Number));
  const questionPrompts = {};
  const pairRe = /\[\s*(\d{1,2})\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
  let pm;
  while ((pm = pairRe.exec(html))) {
    const n = Number(pm[1]);
    const text = pm[2];
    if (!qNums.has(n) || text.length < 15 || questionPrompts[n]) continue;
    questionPrompts[n] = text.replace(/\\"/g, '"').replace(/\\n/g, ' ');
  }

  return { passages, answerKey, partRanges, questionPrompts };
}

// Which passage part a question number belongs to, and that passage's full
// text (paragraphs joined, letter markers included since a paragraph letter
// is itself sometimes the answer being justified, e.g. matching-paragraph
// questions).
export function passageForQuestion(content, questionNumber) {
  const partIndex = content.partRanges.findIndex(([start, end]) => questionNumber >= start && questionNumber <= end);
  if (partIndex === -1) return null;
  const part = content.passages[String(partIndex + 1)];
  if (!part) return null;
  const text = (part.paras || [])
    .map(([letter, para]) => (letter ? `[${letter}] ${para}` : para))
    .join('\n\n');
  return { title: part.title || `Passage ${partIndex + 1}`, text };
}

export const EXPLANATION_SYSTEM_PROMPT = `You write short "why is this the answer" explanations for IELTS Reading questions, for a student reviewing their own marked test.

You will be given one passage in full, one question, and its correct answer. Respond with ONLY a JSON object, no other text, no markdown fences:

{"evidence": "...", "reasonIntro": "...", "tip": "..."}

Rules for "evidence":
- Must be copied EXACTLY, character-for-character, from the passage text you were given -- same words, same punctuation, same casing. Do not paraphrase, summarize, or fix anything about it.
- Choose the shortest contiguous span (usually one sentence, sometimes a clause) that by itself justifies the correct answer.
- If the answer is NOT GIVEN, quote the sentence(s) closest to the topic where a reader might mistakenly look for the answer, since there is no confirming sentence to quote.
- Never invent or lightly reword a quote to make it fit. If you cannot find an exact matching span, pick the closest real sentence instead of altering one.

Rules for "reasonIntro": one plain sentence connecting the quoted evidence to why the correct answer follows from it. Do not just restate the answer.

Rules for "tip": one short, generic sentence on how to approach this question type in general (not specific to this passage) -- useful advice a student could reuse on a different test.`;

export function buildExplanationRequest({ passageTitle, passageText, questionNumber, questionPrompt, correctAnswer }) {
  return {
    content:
      `--- PASSAGE: ${passageTitle} ---\n${passageText}\n\n` +
      `--- QUESTION ${questionNumber} ---\n${questionPrompt}\n\n` +
      `--- CORRECT ANSWER ---\n${correctAnswer}\n\n` +
      `Return the JSON object described in your instructions.`
  };
}

// Whitespace/case-insensitive substring check -- the model's quote must be a
// real span of the passage, not merely similar to one. This is the guard that
// keeps a hallucinated "evidence" quote from ever reaching a student.
export function evidenceVerifiedInPassage(evidence, passageText) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const needle = norm(evidence);
  if (needle.length < 8) return false;
  return norm(passageText).includes(needle);
}
