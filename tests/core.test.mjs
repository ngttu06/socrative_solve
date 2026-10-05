import test from "node:test";
import assert from "node:assert/strict";
import "../extension/core.js";
const Core = globalThis.SocrativeCore;
const payload = { success: true, data: { id: 1, name: "Bài ôn tập", questions: [{
  questionId: 2, questionText: "<p>ケーキは（ ）です。</p>", type: "MC", allowMultipleAnswers: false,
  answers: [{ id: "10", text: "あまい" }, { id: "11", text: "からい" }],
}] } };
const q = Core.parseQuizResponse(payload).questions[0];
const answer = overrides => JSON.stringify({ questionId: "2", answerIds: ["10"], abstain: false, explanation: "Bánh ngọt.", ...overrides });

test("API response parses 50 Unicode questions and discards unrelated metadata", () => {
  const input = structuredClone(payload);
  input.cookie = "secret";
  input.data.room_name = "private-room";
  input.data.questions = Array.from({ length: 50 }, (_, n) => ({ ...payload.data.questions[0],
    questionId: n + 1, token: "secret", answers: payload.data.questions[0].answers.map(a => ({ ...a, authorization: "secret" })) }));
  const quiz = Core.parseQuizResponse(input);
  assert.equal(quiz.questions.length, 50);
  assert.equal(quiz.name, "Bài ôn tập");
  assert.equal(quiz.questions[0].text, "ケーキは（ ）です。");
  assert.equal(quiz.questions[0].answers[0].text, "あまい");
  assert.equal(quiz.questions[0].id, "1");
  assert.doesNotMatch(JSON.stringify(quiz), /cookie|authorization|token|room_name|secret/i);
});

test("API response rejects missing data, failed responses, invalid IDs and oversized lists", () => {
  for (const input of [null, {}, { ...payload, success: false }, { success: true, data: {} },
    { success: true, data: { ...payload.data, questions: Array(501).fill(payload.data.questions[0]) } }]) {
    assert.throws(() => Core.parseQuizResponse(input), /API/);
  }
  assert.throws(() => Core.parseQuizResponse({ ...payload, data: { ...payload.data, id: "../bad" } }), /ID/);
  assert.throws(() => Core.parseQuizResponse({ ...payload, data: { ...payload.data, questions: Array(2).fill(payload.data.questions[0]) } }), /trùng/);
});

test("API parsing skips questions without choices and preserves multiple-answer settings", () => {
  const input = structuredClone(payload);
  input.data.questions[0].allowMultipleAnswers = true;
  input.data.questions.push({ questionId: 3, type: "SA", questionText: "Tự luận", answers: [] });
  const quiz = Core.parseQuizResponse(input);
  assert.equal(quiz.questions.length, 1);
  assert.equal(quiz.questions[0].multiple, true);
});

test("normalized API data enforces quiz and question limits", () => {
  const quiz = Core.parseQuizResponse(payload);
  assert.deepEqual(Core.validateQuizzes([quiz]), [quiz]);
  assert.throws(() => Core.validateQuizzes(null));
  assert.throws(() => Core.validateQuizzes(Array(11).fill(quiz)), /10/);
  assert.throws(() => Core.validateQuizzes([{ ...quiz, questions: Array(1001).fill(q) }]), /1.000/);
  assert.throws(() => Core.validateQuestion({ ...q, quizId: undefined }), /ID/);
});

test("URL allowlist requires exact HTTPS host and question endpoint", () => {
  assert.equal(Core.isQuestionsUrl("https://student.socrative.com/api/quizzes/1/questions?cache=1"), true);
  for (const url of ["http://student.socrative.com/api/quizzes/1/questions", "https://student.socrative.com.evil.test/api/quizzes/1/questions",
    "https://student.socrative.com:999/api/quizzes/1/questions", "https://student.socrative.com/api/auth/login", "not a url"]) {
    assert.equal(Core.isQuestionsUrl(url), false);
  }
});

test("HTML normalization preserves Unicode and meaningful text without scripts", () => {
  assert.equal(Core.normalizeText("<p>A &amp; B</p><script>bad()</script><p>&#x3042; &#12354;&nbsp;&lt;5</p>"), "A & B あ あ <5");
  assert.equal(Core.normalizeText("&#99999999;"), "");
});

test("question cache and matching ignore randomized answer order, not question content", () => {
  const reversed = { ...q, answers: [...q.answers].reverse() };
  assert.equal(Core.questionKey(q), Core.questionKey(reversed));
  assert.notEqual(Core.questionKey(q), Core.questionKey({ ...q, text: "Another question" }));
  assert.equal(Core.matchQuestion([q], ["11", "10"], q.text), q);
  assert.equal(Core.matchQuestion([q], ["10", "10"], q.text), null);
  assert.equal(Core.matchQuestion([q], ["11", "10"], "wrong question"), null);
});

test("question validation strips unknown fields and rejects duplicate answer IDs", () => {
  const safe = Core.validateQuestion({ ...q, token: "secret", answers: q.answers.map(a => ({ ...a, cookie: "secret" })) });
  assert.doesNotMatch(JSON.stringify(safe), /secret|token|cookie/);
  assert.throws(() => Core.validateQuestion({ ...q, answers: [q.answers[0], q.answers[0]] }), /trùng/);
  assert.throws(() => Core.validateQuestion({ ...q, id: "../x" }), /ID/);
  assert.throws(() => Core.validateQuestion({ ...q, text: "x".repeat(16001) }), /dài/);
});

test("image-only and embedded images are flagged instead of guessed", () => {
  const media = structuredClone(payload); media.data.questions[0].questionText += '<img src="https://test/image.png">';
  assert.equal(Core.parseQuizResponse(media).questions[0].hasMedia, true);
});

test("AI parser accepts validated JSON and fenced JSON", () => {
  assert.deepEqual(Core.parseAIAnswer(answer(), q).answerIds, ["10"]);
  assert.deepEqual(Core.parseAIAnswer("```json\n" + answer() + "\n```", q).answerIds, ["10"]);
});

test("AI parser refuses invented IDs, letters, wrong question, duplicates and multiple single-answer picks", () => {
  for (const changes of [{ answerIds: ["A"] }, { answerIds: ["999"] }, { answerIds: [10] }, { questionId: "99" },
    { answerIds: ["10", "10"] }, { answerIds: ["10", "11"] }, { answerIds: [] }, { abstain: "false" }]) {
    assert.throws(() => Core.parseAIAnswer(answer(changes), q));
  }
  assert.throws(() => Core.parseAIAnswer("The answer is A", q), /JSON/);
});

test("AI supports abstaining and explicit multiple-answer questions", () => {
  assert.equal(Core.parseAIAnswer(answer({ answerIds: [], abstain: true }), q).abstain, true);
  assert.throws(() => Core.parseAIAnswer(answer({ abstain: true }), q));
  assert.deepEqual(Core.parseAIAnswer(answer({ answerIds: ["10", "11"] }), { ...q, multiple: true }).answerIds, ["10", "11"]);
});

test("options without IDs match only unique texts from API, never position", () => {
  const multi = { ...q, multiple: true };
  assert.equal(Core.matchQuestionByText([multi], ["からい", "あまい"], q.text, true), multi);
  assert.equal(Core.matchQuestionByText([multi], ["からい", "あまい"], q.text, false), null);
  assert.equal(Core.matchQuestionByText([multi], ["あまい", "あまい"], q.text, true), null);
  const conflicting = { ...multi, answers: [{ id: "20", text: "あまい" }, { id: "21", text: "からい" }] };
  assert.equal(Core.matchQuestionByText([multi, conflicting], ["からい", "あまい"], q.text, true), null);
  assert.equal(Core.matchQuestionByText([multi, multi], ["からい", "あまい"], q.text, true), multi);
});