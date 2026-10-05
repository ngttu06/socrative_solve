import test from "node:test";
import assert from "node:assert/strict";
import { solveWithAI, solveBatchWithAI } from "../extension/ai.js";
const q = { id: "1", quizId: "1", type: "MC", text: "2 + 2?", multiple: false, hasMedia: false,
  answers: [{ id: "a", text: "4" }, { id: "b", text: "5" }] };
const config = { baseUrl: "https://gatecheap.vn/v1", model: "test-model", apiKey: "test-key-not-real", timeoutMs: 1000 };
const reply = { choices: [{ message: { content: JSON.stringify({ questionId: "1", answerIds: ["a"], abstain: false, explanation: "2 + 2 = 4" }) } }] };

test("AI uses fixed endpoint, sends only question data and Bearer header", async () => {
  let count = 0;
  const result = await solveWithAI({ ...q, cookies: "do not send" }, config, { fetchImpl: async (url, options) => {
    count++;
    assert.equal(url, "https://gatecheap.vn/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-key-not-real");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.doesNotMatch(options.body, /test-key|cookies|do not send/);
    const body = JSON.parse(options.body);
    assert.equal(body.model, config.model);
    assert.equal(body.messages.length, 2);
    return Response.json(reply);
  } });
  assert.equal(count, 1);
  assert.deepEqual(result.answerIds, ["a"]);
});

test("AI rejects non-allowlisted endpoints and media without network calls", async () => {
  const fetchImpl = () => { throw new Error("should not call"); };
  await assert.rejects(solveWithAI(q, { ...config, baseUrl: "https://evil.test" }, { fetchImpl }), /Cấu hình/);
  await assert.rejects(solveWithAI({ ...q, hasMedia: true }, config, { fetchImpl }), /Chưa hỗ trợ/);
});

test("HTTP errors are actionable and do not expose provider bodies or credentials", async () => {
  for (const status of [401, 402, 403, 404, 429, 500]) {
    await assert.rejects(solveWithAI(q, config, { fetchImpl: async () => new Response("secret credential", { status }) }), error => {
      assert.match(error.message, new RegExp(String(status)));
      assert.doesNotMatch(error.message, /secret|credential|test-key/);
      return true;
    });
  }
});

test("timeout and external cancellation reject cleanly", async () => {
  const fetchImpl = (_, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  await assert.rejects(solveWithAI(q, { ...config, timeoutMs: 10 }, { fetchImpl }), /thời gian/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(solveWithAI(q, config, { fetchImpl, signal: controller.signal }), /hủy/);
});

test("invalid and oversized provider payloads are rejected", async () => {
  await assert.rejects(solveWithAI(q, config, { fetchImpl: async () => new Response("not json") }), /JSON/);
  await assert.rejects(solveWithAI(q, config, { fetchImpl: async () => new Response("x".repeat(128001)) }), /quá lớn/);
  await assert.rejects(solveWithAI(q, config, { fetchImpl: async () => Response.json({ choices: [] }) }), /hợp lệ/);
});

test("batch sends multiple questions in one request, validates each result and enforces group size", async () => {
  const questions = [q, { ...q, id: "2", text: "3+3?", answers: [{ id: "c", text: "6" }, { id: "d", text: "7" }] }];
  let calls = 0;
  const fetchImpl = async (_, options) => {
    calls++;
    const sent = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(sent.questions.length, 2);
    assert.doesNotMatch(options.body, /apiKey|cookies|test-key/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: [
      { questionId: "2", answerIds: ["c"], abstain: false }, { questionId: "1", answerIds: ["a"], abstain: false },
    ] }) } }] });
  };
  const results = await solveBatchWithAI(questions, config, { fetchImpl });
  assert.equal(calls, 1);
  assert.deepEqual(results[0].result.answerIds, ["a"]);
  assert.deepEqual(results[1].result.answerIds, ["c"]);
  await assert.rejects(solveBatchWithAI(Array(6).fill(q), config, { fetchImpl }), /1–5/);
  await assert.rejects(solveBatchWithAI([q, q], config, { fetchImpl }), /trùng/);
});