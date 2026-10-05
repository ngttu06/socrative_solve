import "./core.js";
import { cacheId, freshCache } from "./cache.js";
const Core = globalThis.SocrativeCore;
const supported = q => q.type !== "UNSUPPORTED" && !q.hasMedia && q.answers.every(a => a.text);

// One persistent, resumable queue for all tabs. Each provider call solves up to five questions.
export class BatchQueue {
  constructor({ storage, model, solveBatch, consumeBudget, notify, schedule, pendingSingle = () => null }) {
    Object.assign(this, { storage, model, solveBatch, consumeBudget, notify, schedule, pendingSingle });
    this.jobs = [];
    this.enabled = false;
    this.epoch = 0;
    this.writeTail = Promise.resolve();
    this.registrationTail = Promise.resolve();
    this.runner = null;
    this.controller = null;
    this.error = "";
  }

  write(operation) {
    const task = this.writeTail.then(operation);
    this.writeTail = task.catch(() => {});
    return task;
  }

  save() {
    const value = structuredClone({ model: this.model, jobs: this.jobs });
    return this.write(() => this.storage.set({ batchState: value }));
  }

  async init(enabled) {
    const { batchState } = await this.storage.get("batchState");
    this.enabled = enabled;
    if (batchState?.model === this.model && Array.isArray(batchState.jobs)) {
      this.jobs = batchState.jobs;
      for (const entry of this.entries()) {
        if (entry.state === "running") {
          entry.state = "error";
          entry.error = "Lượt AI bị gián đoạn. Bấm thử lại batch để tránh tự tính phí lần nữa.";
        }
      }
      await this.save();
    }
  }

  entries() { return this.jobs.flatMap(job => job.entries); }

  summary() {
    const entries = this.entries();
    const count = state => entries.filter(e => e.state === state).length;
    return { total: entries.length, solved: count("done"), uncertain: count("uncertain"), failed: count("error"),
      skipped: count("skipped"), queued: count("queued"), running: count("running"), enabled: this.enabled,
      active: this.enabled && entries.some(e => e.state === "queued" || e.state === "running"),
      error: this.error || entries.find(e => e.state === "error")?.error || "", batchSize: 5 };
  }

  async snapshot() {
    const entries = this.entries();
    const cache = await this.storage.get(entries.map(e => e.key));
    return { batch: this.summary(), answers: entries.filter(e => freshCache(cache[e.key])).map(e => ({
      key: Core.questionKey(e.question), result: { ...cache[e.key].result, cached: true },
    })) };
  }

  async lookup(key) {
    const entry = this.entries().find(e => e.key === key);
    if (!entry) return null;
    if (entry.state === "error") throw new Error(entry.error + " Dùng nút thử lại batch.");
    if (entry.state === "skipped") throw new Error("Câu này không hỗ trợ giải bằng AI văn bản.");
    if (entry.state === "done" || entry.state === "uncertain") {
      const cached = (await this.storage.get(key))[key];
      if (freshCache(cached)) return { ...cached.result, cached: true };
      entry.state = "queued"; // The shared cache has expired or has been removed.
      await this.save();
    }
    this.kick();
    return { pending: true };
  }

  register(quizzes) {
    const epoch = this.epoch;
    const task = this.registrationTail.then(async () => {
      const safe = Core.validateQuizzes(quizzes);
      if (JSON.stringify(safe).length > 2 * 1024 * 1024) throw new Error("Dữ liệu batch vượt 2 MB.");
      const additions = [];
      for (const quiz of safe) {
        if (new Set(quiz.questions.map(q => q.id)).size !== quiz.questions.length) throw new Error("ID câu hỏi batch bị trùng.");
        const entries = await Promise.all(quiz.questions.map(async question => ({ question,
          key: await cacheId(question, this.model), state: supported(question) ? "queued" : "skipped" })));
        const signature = quiz.id + ":" + entries.map(e => e.key).sort().join(":");
        if (this.jobs.some(job => job.signature === signature) || additions.some(job => job.signature === signature)) continue;
        const cached = await this.storage.get(entries.map(e => e.key));
        for (const entry of entries) if (freshCache(cached[entry.key])) entry.state = cached[entry.key].result.abstain ? "uncertain" : "done";
        additions.push({ id: quiz.id, name: quiz.name, signature, entries });
      }
      if (epoch !== this.epoch) return this.summary();
      if (this.jobs.length + additions.length > 10 || this.entries().length + additions.flatMap(j => j.entries).length > 1000 ||
          JSON.stringify([...this.jobs, ...additions]).length > 3 * 1024 * 1024) {
        throw new Error("Bộ nhớ batch đầy (10 bài / 1.000 câu). Hãy tắt và xóa bộ nhớ trước bài mới.");
      }
      this.jobs.push(...additions);
      if (additions.length) await this.save();
      this.kick();
      return this.summary();
    });
    this.registrationTail = task.catch(() => {});
    return task;
  }

  async setEnabled(enabled) {
    this.enabled = enabled;
    this.epoch++;
    this.controller?.abort();
    for (const entry of this.entries()) if (entry.state === "running") entry.state = "queued";
    await this.save();
    if (enabled) this.kick();
    else await this.schedule(false);
  }

  async clear() {
    this.epoch++;
    this.controller?.abort();
    this.jobs = [];
    this.error = "";
    await this.save();
    await this.schedule(false);
  }

  async retry() {
    if (!this.enabled) throw new Error("Bật gợi ý AI trước khi thử lại batch.");
    if (this.runner || this.summary().active) throw new Error("Chờ batch hiện tại hoàn tất trước khi thử lại.");
    this.error = "";
    for (const entry of this.entries()) {
      if (entry.state === "error" || entry.state === "uncertain") { entry.state = "queued"; delete entry.error; }
    }
    // Remove abstentions from cache so a user-requested retry actually calls the provider.
    const keys = this.entries().filter(e => e.state === "queued").map(e => e.key);
    await this.write(() => this.storage.remove(keys));
    await this.save();
    this.kick();
    return this.summary();
  }

  kick() {
    if (!this.enabled || this.runner || !this.entries().some(e => e.state === "queued")) return;
    this.runner = this.run().catch(async error => {
      this.error = error.message;
      for (const entry of this.entries()) if (["queued", "running"].includes(entry.state)) {
        entry.state = "error"; entry.error = error.message;
      }
      await this.save().catch(() => {});
    }).finally(async () => {
      this.runner = null;
      if (this.enabled && this.entries().some(e => e.state === "queued")) this.kick();
      else await this.schedule(false).catch(() => {});
      await this.notify().catch(() => {});
    });
  }

  async run() {
    const epoch = this.epoch;
    const valid = () => this.enabled && this.epoch === epoch;
    await this.schedule(true);
    while (valid()) {
      const job = this.jobs.find(j => j.entries.some(e => e.state === "queued"));
      if (!job) return;
      const group = [];
      let size = 0;
      for (const entry of job.entries.filter(e => e.state === "queued")) {
        const length = JSON.stringify(entry.question).length;
        if (group.length >= 5 || (group.length && size + length > 24000)) break;
        group.push(entry); size += length;
      }
      // Single-question fallback already in flight is shared rather than billed twice.
      for (const entry of group) {
        const single = this.pendingSingle(entry.key);
        if (single) await single.catch(() => {});
      }
      if (!valid()) return;
      const cached = await this.storage.get(group.map(e => e.key));
      if (!valid()) return;
      const pending = group.filter(e => !freshCache(cached[e.key]));
      for (const entry of group) if (freshCache(cached[entry.key])) entry.state = cached[entry.key].result.abstain ? "uncertain" : "done";
      if (!pending.length) { await this.save(); await this.notify(); continue; }
      for (const entry of pending) entry.state = "running";
      await this.save();
      if (!valid()) return;
      await this.notify();
      this.controller = new AbortController();
      try {
        await this.consumeBudget();
        if (!valid()) return;
        const results = await this.solveBatch(pending.map(e => e.question), this.controller.signal);
        if (!valid()) return;
        const values = {};
        const updates = [];
        for (const entry of pending) {
          const answer = results.find(r => r.questionId === entry.question.id);
          if (answer?.result) {
            updates.push({ entry, state: answer.result.abstain ? "uncertain" : "done" });
            values[entry.key] = { createdAt: Date.now(), result: answer.result };
          } else updates.push({ entry, state: "error", error: answer?.error || "AI thiếu kết quả câu hỏi." });
        }
        await this.write(() => valid() ? this.storage.set(values) : Promise.resolve());
        if (!valid()) return;
        for (const update of updates) {
          update.entry.state = update.state;
          if (update.error) update.entry.error = update.error;
          else delete update.entry.error;
        }
      } catch (error) {
        if (!valid()) return;
        for (const entry of pending) { entry.state = "error"; entry.error = error.message; }
        // Authentication, quota, network and timeout errors pause the rest; no automatic paid retries.
        for (const entry of this.entries()) if (entry.state === "queued") { entry.state = "error"; entry.error = error.message; }
      } finally { this.controller = null; }
      if (!valid()) return;
      await this.save();
      await this.notify();
    }
  }
}