import "./core.js";
import { AI_CONFIG } from "./config.private.js";
import { solveBatchWithAI } from "./ai.js";
import { cacheId as makeCacheId, freshCache } from "./cache.js";
import { BatchQueue } from "./batch.js";

const Core = globalThis.SocrativeCore;
let enabled = false;
let budget = { start: Date.now(), count: 0 };
let mutationTail = Promise.resolve();
const batch = new BatchQueue({
  storage: chrome.storage.session, model: AI_CONFIG.model,
  solveBatch: (questions, signal) => solveBatchWithAI(questions, AI_CONFIG, { signal }),
  consumeBudget,
  notify: () => broadcast("SC_RESULTS"),
  schedule: async active => {
    if (active) await chrome.alarms.create("sc-batch", { periodInMinutes: 1 });
    else await chrome.alarms.clear("sc-batch");
  },
});
const ready = (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
  const [settings, session] = await Promise.all([
    chrome.storage.local.get({ enabled: false }), chrome.storage.session.get(["budget", "apiDataVersion"]),
  ]);
  enabled = settings.enabled === true;
  if (session.budget) budget = session.budget;
  // Discard data from older versions whose source cannot be verified as a live API response.
  if (session.apiDataVersion !== 1) {
    const data = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(data).filter(k => k.startsWith("answer:") || k === "quizzes" || k === "batchState"));
    await chrome.storage.session.set({ apiDataVersion: 1 });
  }
  await batch.init(enabled);
  batch.kick();
})();

async function consumeBudget() {
  if (!enabled) throw new Error("Gợi ý AI đã tắt.");
  if (Date.now() - budget.start >= 3600000) budget = { start: Date.now(), count: 0 };
  if (budget.count >= 120) throw new Error("Đã đạt giới hạn an toàn 120 lượt AI/giờ. Hãy chờ giờ tiếp theo.");
  budget.count++;
  await chrome.storage.session.set({ budget: { ...budget } });
}

async function broadcast(type = "SC_REFRESH") {
  const tabs = await chrome.tabs.query({ url: ["https://b.socrative.com/*", "https://student.socrative.com/*"] });
  await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type }).catch(() => {})));
}

function isPopup(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
}

function isPage(sender) {
  return sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && sender.frameId === 0 &&
    Core.isSocrativeUrl(sender.url);
}

async function cacheId(question) {
  return makeCacheId(question, AI_CONFIG.model);
}

async function solve(question) {
  if (!enabled) throw new Error("Chưa bật gợi ý AI trong popup.");
  const q = Core.validateQuestion(question);
  const signature = Core.questionKey(q);
  if (!batch.entries().some(entry => entry.question.id === q.id && entry.question.quizId === q.quizId &&
      Core.questionKey(entry.question) === signature)) {
    throw new Error("Chưa nhận được câu hỏi này từ API Socrative. Hãy tải lại trang hoặc mở lại bài.");
  }
  const key = await cacheId(q);
  const stored = (await chrome.storage.session.get(key))[key];
  if (!enabled) throw new Error("Gợi ý AI đã tắt.");
  if (freshCache(stored)) return { ...stored.result, cached: true };
  const queued = await batch.lookup(key);
  if (queued) return queued;
  throw new Error("Không còn dữ liệu API cho câu hỏi này. Hãy tải lại trang.");
}

async function state(includeQuizzes) {
  const summary = batch.summary();
  return { enabled, model: AI_CONFIG.model, provider: "gatecheap.vn", apiQuestionCount: summary.total,
    batch: summary, ...(includeQuizzes ? { quizzes: batch.jobs.map(job => ({
      id: job.id, name: job.name, questions: job.entries.map(entry => entry.question),
    })), ...(await batch.snapshot()) } : {}) };
}

async function mutate(message) {
  switch (message.type) {
    case "SC_ENABLE":
      if (typeof message.enabled !== "boolean") throw new Error("Cài đặt không hợp lệ.");
      enabled = message.enabled;
      await chrome.storage.local.set({ enabled });
      await batch.setEnabled(enabled);
      break;
    case "SC_CLEAR": {
      await batch.clear();
      const data = await chrome.storage.session.get(null);
      await batch.write(() => chrome.storage.session.remove(Object.keys(data).filter(k => k.startsWith("answer:"))));
      break;
    }
    case "SC_BATCH_RETRY":
      await batch.retry();
      break;
    default: throw new Error("Lệnh không được hỗ trợ.");
  }
  await broadcast();
  return state(false);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("SC_")) return false;
  (async () => {
    await ready;
    const popup = isPopup(sender);
    const page = isPage(sender);
    if (!popup && !page) throw new Error("Nguồn gửi không được phép.");
    if (message.type === "SC_STATE" && popup) return state(false);
    if (message.type === "SC_DATA" && page) return state(true);
    if (message.type === "SC_BATCH_DATA" && page) return batch.snapshot();
    if (message.type === "SC_QUIZZES" && page) return batch.register(message.quizzes);
    if (message.type === "SC_SOLVE" && page) return solve(message.question);
    if (popup && ["SC_ENABLE", "SC_CLEAR", "SC_BATCH_RETRY"].includes(message.type)) {
      const task = mutationTail.then(() => mutate(message));
      mutationTail = task.catch(() => {});
      return task;
    }
    throw new Error("Lệnh không được phép trong ngữ cảnh này.");
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || "Extension gặp lỗi." }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "sc-batch") void ready.then(() => batch.kick()).catch(() => {});
});