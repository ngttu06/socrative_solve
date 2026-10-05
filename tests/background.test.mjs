import test from "node:test";
import assert from "node:assert/strict";

test("API-only service worker migration, permissions, batch, cache and cancellation", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let listener;
  let calls = 0;
  let hold = null;
  const access = [];
  const store = () => {
    const data = {};
    return {
      data,
      async setAccessLevel(value) { access.push(value.accessLevel); },
      async get(keys) {
        if (keys === null) return structuredClone(data);
        if (typeof keys === "string") return { [keys]: structuredClone(data[keys]) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, structuredClone(data[k])]));
        return { ...keys, ...structuredClone(data) };
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    };
  };
  const local = store(), session = store();
  session.data.quizzes = [{ id: "legacy", name: "Old imported quiz", questions: [] }];
  session.data.batchState = { model: "gpt-6.1-sol", jobs: [{ id: "legacy", entries: [] }] };
  session.data["answer:legacy"] = { createdAt: Date.now(), result: { answerIds: ["a"] } };
  session.data.budget = { start: Date.now(), count: 2 };
  globalThis.chrome = {
    alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
    storage: { local, session },
    runtime: { id: "test-extension", getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { async query() { return [{ id: 7 }]; }, async sendMessage() {}, onRemoved: { addListener() {} } },
  };
  globalThis.fetch = async (_, options) => {
    calls++;
    if (hold) await new Promise((resolve, reject) => {
      hold.release = resolve;
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      if (options.signal.aborted) reject(new DOMException("aborted", "AbortError"));
    });
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const answer = q => ({ questionId: q.questionId, answerIds: [q.answers[0].id], abstain: false, explanation: "Test" });
    return Response.json({ choices: [{ message: { content: JSON.stringify(input.questions
      ? { results: input.questions.map(answer) } : answer(input)) } }] });
  };
  const page = { id: "test-extension", frameId: 0, tab: { id: 7 }, url: "https://b.socrative.com/student-v2/quiz" };
  const popup = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" };
  const q = { id: "1", quizId: "1", type: "MC", text: "2+2?", multiple: false, hasMedia: false,
    answers: [{ id: "a", text: "4" }, { id: "b", text: "5" }] };
  try {
    await import(`../extension/background.js?test=${Date.now()}`);
    const send = (message, sender = popup) => new Promise(resolve => listener(message, sender, resolve));
    const initial = await send({ type: "SC_STATE" });
    assert.equal(initial.data.enabled, false);
    assert.equal(initial.data.apiQuestionCount, 0);
    assert.equal(session.data.quizzes, undefined);
    assert.equal(session.data["answer:legacy"], undefined);
    assert.equal(session.data.batchState, undefined);
    assert.equal(session.data.apiDataVersion, 1);
    assert.equal(session.data.budget.count, 2, "Migration must preserve usage limits");
    assert.deepEqual(access, ["TRUSTED_CONTEXTS", "TRUSTED_CONTEXTS"]);
    assert.equal((await send({ type: "SC_SOLVE", question: q }, page)).ok, false);
    assert.equal(calls, 0);
    assert.equal((await send({ type: "SC_ENABLE", enabled: true }, page)).ok, false);
    assert.equal((await send({ type: "SC_STATE" }, { ...page, url: "https://evil.test" })).ok, false);
    assert.equal((await send({ type: "SC_ENABLE", enabled: true })).data.enabled, true);

    assert.match((await send({ type: "SC_SOLVE", question: q }, page)).error, /API Socrative/);
    assert.equal(calls, 0, "DOM-only questions must never trigger AI calls");
    assert.equal((await send({ type: "SC_IMPORT", quizzes: [] })).ok, false, "Removed import commands are rejected");
    await send({ type: "SC_ENABLE", enabled: false });
    const batchQuiz = { id: "batch", name: "Batch", questions: Array.from({ length: 12 }, (_, i) => ({
      ...q, id: String(i + 10), quizId: "batch", text: `Question ${i + 10}?`,
      answers: [{ id: `${i}-a`, text: "A" }, { id: `${i}-b`, text: "B" }],
    })) };
    const denied = await send({ type: "SC_QUIZZES", quizzes: [batchQuiz] }, { ...page, url: "https://evil.test" });
    assert.equal(denied.ok, false);
    assert.equal((await send({ type: "SC_QUIZZES", quizzes: [batchQuiz] })).ok, false);
    assert.equal((await send({ type: "SC_QUIZZES", quizzes: [batchQuiz] }, page)).data.total, 12);
    assert.equal((await send({ type: "SC_STATE" })).data.apiQuestionCount, 12);
    assert.equal((await send({ type: "SC_DATA" }, page)).data.quizzes[0].questions.length, 12);
    assert.equal(calls, 0, "API data is queued while disabled, not sent to AI");
    const previousCalls = calls;
    await send({ type: "SC_ENABLE", enabled: true });
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await send({ type: "SC_STATE" })).data.batch.solved === 12) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await send({ type: "SC_STATE" })).data.batch.solved, 12);
    assert.equal(calls - previousCalls, 3);
    const prefetched = await send({ type: "SC_SOLVE", question: batchQuiz.questions[11] }, page);
    assert.equal(prefetched.data.cached, true);
    assert.deepEqual(prefetched.data.answerIds, ["11-a"]);
    const reversed = { ...batchQuiz.questions[11], answers: [...batchQuiz.questions[11].answers].reverse() };
    assert.equal((await send({ type: "SC_SOLVE", question: reversed }, page)).data.cached, true);
    assert.match((await send({ type: "SC_SOLVE", question: { ...reversed, text: "Changed DOM text" } }, page)).error, /API Socrative/);
    await send({ type: "SC_QUIZZES", quizzes: [batchQuiz] }, page);
    assert.equal(calls - previousCalls, 3);
    assert.equal((await send({ type: "SC_BATCH_DATA" }, page)).data.answers.length, 12);

    hold = {};
    const cancelQuiz = { id: "cancel", name: "Cancel test", questions: [{ ...q, quizId: "cancel" }] };
    await send({ type: "SC_QUIZZES", quizzes: [cancelQuiz] }, page);
    while (!hold.release) await new Promise(r => setTimeout(r, 5));
    await send({ type: "SC_ENABLE", enabled: false });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await send({ type: "SC_STATE" })).data.batch.running) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await send({ type: "SC_SOLVE", question: q }, page)).ok, false);
    hold = null;
    await send({ type: "SC_CLEAR" });
    assert.equal(Object.keys(session.data).filter(k => k.startsWith("answer:")).length, 0);
    assert.equal((await send({ type: "SC_STATE" })).data.apiQuestionCount, 0);
    assert.equal((await send({ type: "SC_DATA" }, page)).data.quizzes.length, 0);
    assert.equal(session.data.budget.count, 6, "Clearing cache must not reset usage limits");
    assert.doesNotMatch(JSON.stringify(session.data), /apiKey|Bearer|sk-/);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});