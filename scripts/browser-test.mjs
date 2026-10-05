// Real Chrome DOM + unpacked MV3 extension, using CDP directly (no dependencies).
// All page/API traffic is fulfilled locally. A temporary copy uses a dummy API key.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(root, ".test-artifacts");
await mkdir(artifacts, { recursive: true });
const temp = await mkdtemp(path.join(tmpdir(), "socrative-extension-test-"));
const extensionDir = path.join(temp, "extension");
await cp(path.join(root, "extension"), extensionDir, { recursive: true,
  filter: source => path.basename(source) !== "config.private.js" });
await writeFile(path.join(extensionDir, "config.private.js"),
  'export const AI_CONFIG = { baseUrl: "https://gatecheap.vn/v1", model: "gpt-6.1-sol", apiKey: "browser-test-key", timeoutMs: 25000 };\n');
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const browser = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-sync",
  "--enable-unsafe-extension-debugging", "--remote-debugging-port=0", `--user-data-dir=${path.join(temp, "profile")}`, "about:blank"],
{ stdio: "ignore" });
let ws;
let seq = 0;
const pending = new Map();
const handlers = new Map();
const failures = [];
const checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`Timeout: ${label}`);
}

function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

function on(session, method, fn) { handlers.set(`${session ?? ""}:${method}`, fn); }
async function evaluate(session, expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
function check(name) { checks.push(name); console.log(`PASS: ${name}`); }

try {
  const devtools = await waitFor(async () => {
    try { return await readFile(path.join(temp, "profile", "DevToolsActivePort"), "utf8"); } catch { return null; }
  }, "Chrome debugging endpoint");
  const [port, socketPath] = devtools.trim().split(/\r?\n/);
  ws = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
  await once(ws, "open");
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer); pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
    } else {
      const handler = handlers.get(`${message.sessionId ?? ""}:${message.method}`);
      if (handler) Promise.resolve(handler(message.params)).catch(error => failures.push(error.message));
    }
  });
  const { id: extensionId } = await command("Extensions.loadUnpacked", { path: extensionDir });
  assert.ok(extensionId);
  check("Chrome loads the unpacked Manifest V3 extension");
  const worker = await waitFor(async () => {
    const { targetInfos } = await command("Target.getTargets");
    return targetInfos.find(t => t.type === "service_worker" && t.url.includes(extensionId));
  }, "extension service worker");
  const { sessionId: workerSession } = await command("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  await command("Runtime.enable", {}, workerSession);
  on(workerSession, "Runtime.exceptionThrown", p => { failures.push(`Worker: ${p.exceptionDetails.text}`); });
  let aiCalls = 0;
  let aiMode = "ok";
  let delay = 0;
  on(workerSession, "Fetch.requestPaused", async event => {
    const request = event.request;
    if (request.url !== "https://gatecheap.vn/v1/chat/completions") {
      await command("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, workerSession);
      return;
    }
    aiCalls++;
    assert.equal(request.headers.Authorization, "Bearer browser-test-key");
    const data = JSON.parse(request.postData);
    const input = JSON.parse(data.messages[1].content);
    const questions = input.questions ?? [input];
    assert.equal(data.model, "gpt-6.1-sol");
    assert.doesNotMatch(request.postData, /cookie|room_name|authorization|browser-test-key/i);
    const mode = aiMode;
    const results = questions.map(question => ({ questionId: question.questionId,
      answerIds: question.multipleAnswers ? question.answers.slice(0, 2).map(a => a.id) : [question.answers[0].id],
      abstain: false, explanation: "Kết quả AI giả lập để kiểm thử, không phải lời giải thật." }));
    if (delay) await sleep(delay);
    const body = mode === "error" ? { error: "mock rate limit" } : { choices: [{ message: {
      content: JSON.stringify(input.questions ? { results } : results[0]),
    } }] };
    await command("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: mode === "error" ? 429 : 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") }, workerSession);
  });
  await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, workerSession);

  const payload = { success: true, data: { id: 81231799, name: "Local browser test", questions: [
    { questionId: 763466633, type: "MC", questionText: "1. Chọn đáp án đúng điền vào chỗ trống: ケーキは（ ）です。", allowMultipleAnswers: false,
      answers: [{ id: "2655695188", text: "あまい" }, { id: "2655695189", text: "からい" }, { id: "2655695190", text: "にがい" }, { id: "2655695191", text: "すっぱい" }] },
    { questionId: 763466634, type: "MC", questionText: "2. Chọn đáp án đúng điền vào chỗ trống: コーヒーは（ ）です。", allowMultipleAnswers: false,
      answers: [{ id: "2655695192", text: "にがい" }, { id: "2655695193", text: "からい" }, { id: "2655695194", text: "さむい" }, { id: "2655695195", text: "すずしい" }] },
    { questionId: 763466635, type: "MC", questionText: "3. Chọn các số chẵn.", allowMultipleAnswers: true,
      answers: [{ id: "201", text: "2" }, { id: "202", text: "4" }, { id: "203", text: "5" }] },
  ] } };
  let main;
  try { main = (await readFile(path.join(root, "Socrative - Student.html"), "utf8")).match(/<main[\s\S]*?<\/main>/)[0]; }
  catch { main = '<main id="main-content"><article><div class="rich-text">' + payload.data.questions[0].questionText + '</div><div role="radiogroup">' +
    payload.data.questions[0].answers.slice().reverse().map(a => `<button role="radio" value="${a.id}"><span class="rich-text">${a.text}</span></button>`).join("") + '</div></article></main>'; }
  const fixture = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Local Socrative fixture</title><style>
    body{font:16px system-ui;background:#fafafa;margin:40px}main{max-width:640px;margin:auto}button{display:block;width:100%;padding:16px;margin:10px 0;background:white;border:1px solid #ccc;border-radius:8px;cursor:pointer;text-align:left} .rich-text{line-height:1.6} h2{font-size:14px;color:#555}
    </style></head><body>${main}</body></html>`;
  const { targetId } = await command("Target.createTarget", { url: "about:blank" });
  const { sessionId: page } = await command("Target.attachToTarget", { targetId, flatten: true });
  await command("Page.enable", {}, page);
  await command("Runtime.enable", {}, page);
  on(page, "Runtime.exceptionThrown", p => { failures.push(`Page: ${p.exceptionDetails.text}`); });
  on(page, "Fetch.requestPaused", async event => {
    const url = event.request.url;
    let body, type;
    if (url.startsWith("https://b.socrative.com/student-v2/quiz")) { body = fixture; type = "text/html; charset=utf-8"; }
    else if (url === "https://student.socrative.com/api/quizzes/86621056/questions") { body = JSON.stringify(payload); type = "application/json"; }
    else { await command("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, page); return; }
    await command("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: type }, { name: "Access-Control-Allow-Origin", value: "*" }],
      body: Buffer.from(body).toString("base64") }, page);
  });
  await command("Fetch.enable", { patterns: [{ urlPattern: "http*" }] }, page);
  await command("Page.navigate", { url: "https://b.socrative.com/student-v2/quiz" }, page);
  await waitFor(() => evaluate(page, "Boolean(document.querySelector('#main-content article'))"), "fixture DOM without API data");

  const { targetId: popupTarget } = await command("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
  const { sessionId: popup } = await command("Target.attachToTarget", { targetId: popupTarget, flatten: true });
  await command("Runtime.enable", {}, popup);
  on(popup, "Runtime.exceptionThrown", p => { failures.push(`Popup: ${p.exceptionDetails.text}`); });
  await waitFor(() => evaluate(popup, "Boolean(document.getElementById('enabled') && !document.getElementById('enabled').disabled)"), "popup initialization");
  const send = (type, extra = {}) => evaluate(popup, `chrome.runtime.sendMessage(${JSON.stringify({ type, ...extra })})`);
  const tabId = await evaluate(popup, `(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url==='https://b.socrative.com/student-v2/quiz').id})()`);
  const tabStatus = () => evaluate(popup, `chrome.tabs.sendMessage(${tabId}, {type:'SC_TAB_STATUS'}).then(r=>r.data)`);
  const cursors = () => evaluate(page, `[...document.querySelectorAll('button[role="radio"],button[role="checkbox"]')].map(e=>({id:e.getAttribute('value'),cursor:getComputedStyle(e).cursor,child:getComputedStyle(e.querySelector('.rich-text')).cursor}))`);
  assert.equal(aiCalls, 0);
  assert.equal((await send("SC_STATE")).data.enabled, false);
  check("disabled by default; no AI calls before user opt-in");
  assert.equal((await send("SC_ENABLE", { enabled: true })).ok, true);
  await waitFor(async () => (await tabStatus()).phase === "waiting" && (await cursors()).every(a => a.cursor === "default"), "waiting for live API data");
  await sleep(700);
  assert.equal(aiCalls, 0);
  assert.equal((await send("SC_STATE")).data.apiQuestionCount, 0);
  assert.match((await tabStatus()).message, /API/);
  assert.equal(await evaluate(popup, "document.querySelectorAll('input[type=file]').length"), 0);
  assert.doesNotMatch(await evaluate(popup, "document.body.textContent"), /\bHAR\b/i);
  check("without API data, DOM questions stay neutral and popup offers no file import");
  assert.equal((await send("SC_IMPORT", { quizzes: [] })).ok, false);
  check("removed import message is rejected by the service worker");
  await evaluate(page, "fetch('https://student.socrative.com/api/quizzes/86621056/questions').then(r=>r.json()).then(x=>{window.fixturePayload=x})");
  await waitFor(async () => (await tabStatus()).phase === "ready", "AI ready");
  assert.equal((await tabStatus()).source, "API Socrative");
  assert.equal((await send("SC_STATE")).data.apiQuestionCount, 3);
  let values = await cursors();
  assert.equal(values.length, 4);
  assert.equal(values.find(a => a.id === "2655695188").cursor, "pointer");
  assert.ok(values.filter(a => a.id !== "2655695188").every(a => a.cursor === "default" && a.child === "default"));
  assert.equal(values.find(a => a.id === "2655695188").child, "pointer");
  assert.equal(aiCalls, 1);
  check("captures actual fetch response and maps shuffled answers by ID, including nested text cursor");
  await evaluate(page, `(()=>{const group=document.querySelector('[role="radiogroup"]');[...group.querySelectorAll('button')].reverse().forEach(e=>group.append(e));})()`);
  await sleep(400);
  assert.equal((await cursors()).find(a => a.id === "2655695188").cursor, "pointer");
  assert.equal(aiCalls, 1);
  check("DOM reorder preserves the correct pointer without another AI call");

  async function showQuestion(index) {
    await evaluate(page, `(()=>{const q=${JSON.stringify(payload.data.questions[index])};const article=document.querySelector('#main-content article');article.innerHTML='';const text=document.createElement('div');text.className='rich-text';text.textContent=q.questionText;article.append(text);const group=document.createElement('div');group.setAttribute('role',q.allowMultipleAnswers?'group':'radiogroup');article.append(group);for(const a of [...q.answers].reverse()){const b=document.createElement('button');b.setAttribute('role',q.allowMultipleAnswers?'checkbox':'radio');if(!q.allowMultipleAnswers)b.value=a.id;const span=document.createElement('span');span.className='rich-text';span.textContent=a.text;b.append(span);group.append(b)}})()`);
  }
  await waitFor(async () => (await send("SC_STATE")).data.batch.solved === 3, "whole quiz prefetched");
  assert.equal(aiCalls, 1);
  check("one batch solves every API question before navigation");
  await showQuestion(1);
  await waitFor(async () => (await tabStatus()).phase === "ready", "prefetched second question");
  assert.equal((await cursors()).find(a => a.id === "2655695192").cursor, "pointer");
  assert.equal(aiCalls, 1);
  await showQuestion(0);
  await waitFor(async () => (await tabStatus()).phase === "ready", "cached first question");
  assert.equal((await cursors()).find(a => a.id === "2655695188").cursor, "pointer");
  assert.equal(aiCalls, 1);
  check("navigating prefetched questions shows pointers without new AI requests");

  const quizImage = await command("Page.captureScreenshot", { format: "png" }, page);
  await writeFile(path.join(artifacts, "quiz.png"), Buffer.from(quizImage.data, "base64"));
  await send("SC_ENABLE", { enabled: false });
  await waitFor(async () => (await tabStatus()).phase === "disabled", "disable content");
  assert.equal(await evaluate(page, "document.querySelectorAll('[data-sc-cursor]').length"), 0);
  check("turning off restores original cursors");
  await send("SC_CLEAR");
  await waitFor(async () => (await send("SC_STATE")).data.apiQuestionCount === 3, "observed API re-registered after clearing cache");
  assert.equal(aiCalls, 1);
  check("clearing cache re-registers observed API data without calling AI while disabled");

  aiMode = "error";
  await send("SC_ENABLE", { enabled: true });
  await waitFor(async () => (await tabStatus()).phase === "error", "AI rate limit error");
  assert.match((await tabStatus()).message, /429/);
  assert.ok((await cursors()).every(a => a.cursor === "default"));
  check("AI HTTP errors leave all answer cursors neutral");

  await send("SC_ENABLE", { enabled: false });
  await sleep(2100);
  aiMode = "ok";
  await showQuestion(2);
  await send("SC_ENABLE", { enabled: true });
  await send("SC_BATCH_RETRY");
  await waitFor(async () => (await tabStatus()).phase === "ready", "multiple answer question");
  const multiCursors = await evaluate(page, `[...document.querySelectorAll('[role="checkbox"]')].map(e=>({text:e.textContent,cursor:getComputedStyle(e).cursor,hasId:e.hasAttribute('value')}))`);
  assert.ok(multiCursors.every(a => !a.hasId));
  assert.equal(multiCursors.find(a => a.text === "2").cursor, "pointer");
  assert.equal(multiCursors.find(a => a.text === "4").cursor, "pointer");
  assert.equal(multiCursors.find(a => a.text === "5").cursor, "default");
  check("multiple answers without DOM IDs match unique API text to the correct IDs");

  const callsBeforeUnsupported = aiCalls;
  await evaluate(page, `document.querySelectorAll('[role="checkbox"] .rich-text')[0].textContent='4'`);
  await waitFor(async () => (await tabStatus()).phase === "unsupported", "ambiguous checkbox text");
  assert.ok((await cursors()).every(a => a.cursor === "default"));
  assert.equal(aiCalls, callsBeforeUnsupported);
  check("ambiguous duplicate checkbox text fails closed without sending AI requests");

  await showQuestion(0);
  await evaluate(page, `(()=>{const img=document.createElement('img');img.alt='Question image';document.querySelector('article').append(img)})()`);
  await waitFor(async () => (await tabStatus()).phase === "unsupported" && (await cursors()).every(a => a.cursor === "default"), "image question");
  assert.ok((await cursors()).every(a => a.cursor === "default"));
  assert.equal(aiCalls, callsBeforeUnsupported);
  check("media questions remain neutral instead of guessing from incomplete text");

  await send("SC_ENABLE", { enabled: false });
  await command("Page.navigate", { url: "https://b.socrative.com/student-v2/quiz" }, page);
  await waitFor(() => evaluate(page, "Boolean(document.querySelector('#main-content article'))"), "fresh page before XHR");
  await send("SC_CLEAR");
  await waitFor(async () => (await send("SC_STATE")).data.apiQuestionCount === 0, "cleared API queue on fresh page");
  const callsBeforeXHR = aiCalls;
  await send("SC_ENABLE", { enabled: true });
  await waitFor(async () => (await tabStatus()).phase === "waiting", "fresh page waiting for XHR");
  await sleep(700);
  assert.equal(aiCalls, callsBeforeXHR);
  const xhrResponse = await evaluate(page, `new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('GET','https://student.socrative.com/api/quizzes/86621056/questions');xhr.responseType='json';xhr.onload=()=>resolve(xhr.response.success);xhr.onerror=reject;xhr.send()})`);
  assert.equal(xhrResponse, true);
  await waitFor(async () => (await tabStatus()).phase === "ready" && (await send("SC_STATE")).data.batch.solved === 3, "XHR-only batch solved");
  assert.equal(aiCalls, callsBeforeXHR + 1);
  assert.equal((await cursors()).find(a => a.id === "2655695188").cursor, "pointer");
  check("XHR response alone registers and solves the quiz batch while preserving the host response");
  await send("SC_ENABLE", { enabled: false });
  await command("Emulation.setDeviceMetricsOverride", { width: 370, height: 740, deviceScaleFactor: 1, mobile: false }, popup);
  await evaluate(popup, "location.reload()");
  await waitFor(() => evaluate(popup, "Boolean(document.getElementById('enabled') && !document.getElementById('enabled').disabled)"), "popup reload");
  const screenshot = await command("Page.captureScreenshot", { format: "png" }, popup);
  await writeFile(path.join(artifacts, "popup.png"), Buffer.from(screenshot.data, "base64"));
  assert.equal(await evaluate(popup, "document.documentElement.scrollWidth <= innerWidth"), true);
  assert.ok(await evaluate(popup, "document.getElementById('enabled').labels.length > 0"));
  check("popup renders without horizontal overflow and switch has an accessible label");
  assert.deepEqual(failures, []);
  await writeFile(path.join(artifacts, "browser-report.json"), JSON.stringify({ browser: await command("Browser.getVersion"),
    checks, aiCalls, allAINetworkMocked: true, failures }, null, 2));
  console.log(`Completed ${checks.length} browser checks. All ${aiCalls} AI requests were mocked; no provider credits used.`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    try { await command("Browser.close"); } catch { /* Chrome may close before replying. */ }
    ws.close();
  }
  for (const task of pending.values()) clearTimeout(task.timer);
  if (browser.exitCode === null) {
    await Promise.race([once(browser, "exit"), sleep(3000)]);
    if (browser.exitCode === null) browser.kill();
  }
  await sleep(300);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
}