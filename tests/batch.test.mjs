import test from "node:test";
import assert from "node:assert/strict";
import { BatchQueue } from "../extension/batch.js";
import { cacheId } from "../extension/cache.js";
const Core = globalThis.SocrativeCore;
const question = n => ({ id: String(n), quizId: "quiz", text: `Question ${n}?`, type: "MC", multiple: false, hasMedia: false,
  answers: [{ id: `${n}-a`, text: "A" }, { id: `${n}-b`, text: "B" }] });
const quiz = count => ({ id: "quiz", name: "Batch practice", questions: Array.from({ length: count }, (_, n) => question(n + 1)) });
const results = questions => questions.map(q => ({ questionId: q.id, result: { answerIds: [q.answers[0].id], abstain: false, explanation: "Test" } }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await sleep(5); }
  throw new Error("Queue test timeout");
}
async function idle(queue) { await until(() => !queue.runner); await queue.writeTail; }
function harness(overrides = {}) {
  const data = {};
  const storage = {
    async get(keys) {
      if (typeof keys === "string") return { [keys]: structuredClone(data[keys]) };
      return Object.fromEntries(keys.map(key => [key, structuredClone(data[key])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of keys) delete data[key]; },
  };
  const calls = [];
  let budget = 0;
  const queue = new BatchQueue({ storage, model: "test", solveBatch: async qs => { calls.push(qs); return results(qs); },
    consumeBudget: async () => { budget++; }, notify: async () => {}, schedule: async () => {}, ...overrides });
  return { queue, data, calls, storage, budget: () => budget };
}

test("batch parses out-of-order results by question ID and keeps good results when another is missing", () => {
  const qs = [question(1), question(2), question(3)];
  const entries = results([qs[2], qs[0]]).map(r => ({ questionId: r.questionId, ...r.result }));
  const parsed = Core.parseAIBatch(JSON.stringify({ results: entries }), qs);
  assert.deepEqual(parsed[0].result.answerIds, ["1-a"]);
  assert.match(parsed[1].error, /bỏ sót/);
  assert.deepEqual(parsed[2].result.answerIds, ["3-a"]);
  assert.throws(() => Core.parseAIBatch(JSON.stringify({ results: [{ questionId: "999" }] }), qs), /ID/);
  assert.throws(() => Core.parseAIBatch("not JSON", qs), /JSON/);
});

test("50 questions run in 10 requests of 5; repeated APIs/tabs do not rebill", async () => {
  const h = harness();
  await h.queue.init(false);
  await Promise.all([h.queue.register([quiz(50)]), h.queue.register([quiz(50)])]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.queue.summary().total, 50);
  await h.queue.setEnabled(true);
  await idle(h.queue);
  assert.equal(h.calls.length, 10);
  assert.ok(h.calls.every(group => group.length === 5));
  assert.equal(h.budget(), 10);
  assert.equal(h.queue.summary().solved, 50);
  assert.equal((await h.queue.snapshot()).answers.length, 50);
  await h.queue.register([quiz(50)]);
  await idle(h.queue);
  assert.equal(h.calls.length, 10);
});

test("cached questions and media questions are excluded from provider requests", async () => {
  const h = harness();
  await h.queue.init(false);
  const input = quiz(7);
  input.questions[1].hasMedia = true;
  const key = await cacheId(input.questions[0], "test");
  h.data[key] = { createdAt: Date.now(), result: results([input.questions[0]])[0].result };
  await h.queue.register([input]);
  await h.queue.setEnabled(true);
  await idle(h.queue);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].map(q => q.id), ["3", "4", "5", "6", "7"]);
  assert.equal(h.queue.summary().skipped, 1);
  assert.equal(h.queue.summary().solved, 6);
});

test("pending single-question call is shared by batch instead of billed twice", async () => {
  const h = harness({ pendingSingle: key => Promise.resolve().then(() => {
    h.data[key] = { createdAt: Date.now(), result: results([question(1)])[0].result };
  }) });
  await h.queue.init(true);
  await h.queue.register([quiz(1)]);
  await idle(h.queue);
  assert.equal(h.calls.length, 0);
  assert.equal(h.queue.summary().solved, 1);
});

test("partial batch failures retry only failed/uncertain questions", async () => {
  let first = true;
  const calls = [];
  const h = harness({ solveBatch: async qs => {
    calls.push(qs.map(q => q.id));
    const output = results(qs);
    if (first) {
      first = false;
      output[1] = { questionId: qs[1].id, error: "Missing answer" };
      output[2].result = { answerIds: [], abstain: true, explanation: "Uncertain" };
    }
    return output;
  } });
  await h.queue.init(true);
  await h.queue.register([quiz(5)]);
  await idle(h.queue);
  assert.equal(h.queue.summary().solved, 3);
  assert.equal(h.queue.summary().failed, 1);
  assert.equal(h.queue.summary().uncertain, 1);
  await h.queue.retry();
  await idle(h.queue);
  assert.deepEqual(calls[1], ["2", "3"]);
  assert.equal(h.queue.summary().solved, 5);
});

test("provider failure pauses remaining queue without automatic paid retries", async () => {
  let calls = 0;
  const h = harness({ solveBatch: async () => { calls++; throw new Error("AI HTTP 429"); } });
  await h.queue.init(true);
  await h.queue.register([quiz(12)]);
  await idle(h.queue);
  assert.equal(calls, 1);
  assert.equal(h.queue.summary().failed, 12);
  await h.queue.register([quiz(12)]);
  h.queue.kick();
  await idle(h.queue);
  assert.equal(calls, 1);
});

test("turning off cancels a batch, retains queued work, and clear rejects late results", async () => {
  let started = false;
  const h = harness({ solveBatch: (qs, signal) => new Promise((resolve, reject) => {
    started = true;
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }) });
  await h.queue.init(true);
  await h.queue.register([quiz(8)]);
  await until(() => started);
  await h.queue.setEnabled(false);
  await idle(h.queue);
  assert.equal(h.queue.summary().queued, 8);
  assert.equal(h.queue.summary().failed, 0);
  await h.queue.clear();
  assert.equal(h.queue.summary().total, 0);
  assert.equal(Object.keys(h.data).filter(k => k.startsWith("answer:")).length, 0);
});

test("service worker restart restores queued work but does not auto-rebill interrupted requests", async () => {
  const h = harness();
  await h.queue.init(false);
  await h.queue.register([quiz(8)]);
  h.data.batchState.jobs[0].entries[0].state = "running";
  const resumed = new BatchQueue({ storage: h.storage, model: "test", solveBatch: async qs => results(qs),
    consumeBudget: async () => {}, notify: async () => {}, schedule: async () => {} });
  await resumed.init(true);
  assert.equal(resumed.summary().failed, 1);
  resumed.kick();
  await idle(resumed);
  assert.equal(resumed.summary().solved, 7);
  assert.equal(resumed.summary().failed, 1);
});

test("a provider response arriving after clear cannot resurrect answers or jobs", async () => {
  let release;
  const h = harness({ solveBatch: qs => new Promise(resolve => { release = () => resolve(results(qs)); }) });
  await h.queue.init(true);
  await h.queue.register([quiz(5)]);
  await until(() => Boolean(release));
  await h.queue.clear();
  release();
  await idle(h.queue);
  assert.equal(h.queue.summary().total, 0);
  assert.equal(Object.keys(h.data).filter(key => key.startsWith("answer:")).length, 0);
  assert.deepEqual(h.data.batchState.jobs, []);
});

test("large question groups are split by payload size, not only by question count", async () => {
  const h = harness();
  const input = quiz(5);
  input.questions.forEach(q => { q.text += "長".repeat(12500); });
  await h.queue.init(true);
  await h.queue.register([input]);
  await idle(h.queue);
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every(group => group.length === 1));
});