(() => {
  "use strict";
  const Core = globalThis.SocrativeCore;
  const channel = "socrative-cursor-v1";
  const observedQuizzes = new Map();
  const marked = new Set();
  const answerIdsByElement = new WeakMap();
  const readyAnswers = new Map();
  let apiQuizzes = [];
  let enabled = false;
  let initialized = false;
  let current = null;
  let generation = 0;
  let scanTimer;
  let solveTimer;
  let refreshSerial = 0;
  let batchSerial = 0;
  let batchStatus = {};
  let status = { phase: "disabled", message: "Gợi ý AI đang tắt.", explanation: "" };

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "Không liên lạc được với extension.");
    return response.data;
  }

  function clearMarks() {
    for (const element of marked) element.removeAttribute("data-sc-cursor");
    marked.clear();
  }

  function paint(elements, answerIds = []) {
    const selected = new Set(answerIds);
    for (const element of [...marked]) {
      if (!elements.includes(element)) { element.removeAttribute("data-sc-cursor"); marked.delete(element); }
    }
    for (const element of elements) {
      const cursor = selected.has(answerIdsByElement.get(element)) && !element.disabled && element.getAttribute("aria-disabled") !== "true"
        ? "pointer" : "default";
      if (element.getAttribute("data-sc-cursor") !== cursor) element.setAttribute("data-sc-cursor", cursor);
      marked.add(element);
    }
  }

  function visible(element) {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  }

  function readCurrent() {
    const articles = [...document.querySelectorAll("#main-content article")].filter(visible);
    if (articles.length !== 1) return null;
    const article = articles[0];
    const elements = [...article.querySelectorAll('button[role="radio"], button[role="checkbox"]')].filter(visible);
    if (elements.length < 2 || elements.length > 30) return null;
    const questionElement = [...article.querySelectorAll(".rich-text")].find(el => !elements.some(option => option.contains(el)));
    if (!questionElement) return null;
    const plain = value => value.normalize("NFC").replace(/\s+/gu, " ").trim();
    const text = plain(questionElement.textContent ?? "");
    let ids = elements.map(el => el.getAttribute("value"));
    const answers = elements.map(el => ({ id: el.getAttribute("value"), text: plain(el.querySelector(".rich-text")?.textContent ?? "") }));
    const quizzes = new Map(apiQuizzes.map(quiz => [quiz.id, quiz]));
    for (const quiz of observedQuizzes.values()) quizzes.set(quiz.id, quiz);
    const questions = [...quizzes.values()].flatMap(q => q.questions);
    const multiple = elements.some(el => el.getAttribute("role") === "checkbox");
    let candidate;
    if (ids.every(Boolean)) candidate = Core.matchQuestion(questions, ids, text);
    else {
      candidate = Core.matchQuestionByText(questions, answers.map(a => a.text), text, multiple);
      answers.forEach((answer, index) => {
        answer.id = candidate ? candidate.answers.find(a => a.text === answer.text).id : null;
      });
      ids = answers.map(a => a.id);
    }
    elements.forEach((element, index) => answerIdsByElement.set(element, ids[index]));
    const known = candidate?.multiple === multiple &&
      candidate.answers.every(a => answers.some(option => option.id === a.id && option.text === a.text)) ? candidate : null;
    if (!known) return { question: null, elements, key: JSON.stringify(["waiting-api", questions.length > 0, text, multiple, answers]),
      unmapped: questions.length > 0, source: "API Socrative" };
    const domHasMedia = Boolean(article.querySelector("img, audio, video, iframe, canvas, svg:not(button svg)"));
    const question = Core.validateQuestion({ ...known, hasMedia: known.hasMedia || domHasMedia });
    return { question, elements, key: Core.questionKey(question), source: "API Socrative" };
  }

  function reset() {
    generation++;
    clearTimeout(solveTimer);
    current = null;
    clearMarks();
  }

  function scheduleScan() {
    // Immediately remove stale hints if the host reuses answer buttons during a transition.
    if (current) {
      let next;
      try { next = readCurrent(); } catch { next = null; }
      if (!next || next.key !== current.key) {
        reset();
        status = { phase: "waiting", message: "Đang chuyển câu hỏi…", explanation: "" };
        if (enabled && next) paint(next.elements);
      }
    }
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 100);
  }

  function scan() {
    if (!initialized || !enabled) return;
    let next;
    try { next = readCurrent(); } catch (error) {
      reset(); status = { phase: "error", message: error.message, explanation: "" }; return;
    }
    if (!next) {
      reset(); status = { phase: "waiting", message: "Đang chờ câu hỏi trắc nghiệm từ API Socrative.", explanation: "" }; return;
    }
    if (current?.key === next.key) {
      current.elements = next.elements;
      const cached = readyAnswers.get(next.key);
      if (cached && !current.result) applyResult(next, cached);
      paint(current.elements, current.result?.answerIds);
      return;
    }
    reset();
    current = next;
    paint(next.elements);
    if (!next.question) {
      status = { phase: next.unmapped ? "unsupported" : "waiting", source: next.source, explanation: "",
        message: next.unmapped ? "Câu hiển thị chưa khớp dữ liệu API. Không gợi ý khi không đối chiếu chắc chắn."
          : "Chưa nhận được API câu hỏi. Hãy tải lại trang hoặc mở lại bài Socrative." };
      return;
    }
    if (next.question.hasMedia || next.question.type === "UNSUPPORTED" || next.question.answers.some(a => !a.text)) {
      status = { phase: "unsupported", message: "Chưa hỗ trợ câu hỏi ảnh/âm thanh/video hoặc dạng không có lựa chọn chữ.",
        source: next.source, explanation: "" };
      return;
    }
    const cached = readyAnswers.get(next.key);
    if (cached) { applyResult(next, cached); return; }
    status = { phase: "loading", message: "Đang lấy kết quả từ batch API…", source: next.source, explanation: "" };
    const token = generation;
    solveTimer = setTimeout(() => { void solve(next, token); }, 600);
  }

  async function solve(snapshot, token) {
    if (!enabled || generation !== token || current?.key !== snapshot.key) return;
    status = { phase: "loading", message: "Đang lấy kết quả từ batch API…", source: snapshot.source, explanation: "" };
    try {
      const result = await send({ type: "SC_SOLVE", question: snapshot.question });
      if (!enabled || generation !== token || current?.key !== snapshot.key) return;
      if (result.pending) {
        status = { phase: "loading", message: "Câu hiện tại đang chờ trong batch…", explanation: "" };
        return;
      }
      const displayed = readCurrent();
      if (!displayed || displayed.key !== snapshot.key) { scheduleScan(); return; }
      readyAnswers.set(snapshot.key, result);
      current.elements = displayed.elements;
      applyResult(snapshot, result);
    } catch (error) {
      if (!enabled || generation !== token || current?.key !== snapshot.key) return;
      paint(current.elements);
      status = { phase: "error", message: error.message, explanation: "" };
    }
  }

  function applyResult(snapshot, result) {
    current.result = result;
    paint(current.elements, result.answerIds);
    status = { phase: result.abstain ? "uncertain" : "ready",
      message: result.abstain ? "AI chưa đủ thông tin để chọn đáp án." : `Đã có gợi ý${result.cached ? " từ bộ nhớ" : ""}. Rê chuột lên các lựa chọn.`,
      explanation: result.explanation, source: snapshot.source };
  }

  function acceptBatch(data) {
    batchStatus = data.batch;
    for (const answer of data.answers ?? []) readyAnswers.set(answer.key, answer.result);
  }

  async function syncBatch() {
    const serial = ++batchSerial;
    const token = generation;
    try {
      const data = await send({ type: "SC_BATCH_DATA" });
      if (serial !== batchSerial || !enabled) return;
      acceptBatch(data);
      scan();
      if (token === generation && current && !current.result && status.phase === "loading" && !batchStatus.active) {
        void solve(current, generation); // Retrieves the batch error, never automatically retries failed questions.
      }
    } catch { /* The next batch notification or popup refresh can resynchronize. */ }
  }

  async function registerQuizzes() {
    const quizzes = [...observedQuizzes.values()];
    if (quizzes.length) await send({ type: "SC_QUIZZES", quizzes });
  }

  async function refresh() {
    const serial = ++refreshSerial;
    try {
      const data = await send({ type: "SC_DATA" });
      if (serial !== refreshSerial) return;
      reset();
      batchSerial++;
      readyAnswers.clear();
      enabled = data.enabled;
      apiQuizzes = Core.validateQuizzes(data.quizzes);
      acceptBatch(data);
      initialized = true;
      status = { phase: enabled ? "waiting" : "disabled", message: enabled ? "Đang tìm câu hỏi…" : "Gợi ý AI đang tắt.", explanation: "" };
      await registerQuizzes();
      if (serial === refreshSerial) scan();
    } catch (error) {
      if (serial !== refreshSerial) return;
      reset(); enabled = false;
      status = { phase: "error", message: error.message + " Hãy tải lại trang.", explanation: "" };
    }
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== channel || event.data.type !== "QUIZ") return;
    if (!Core.isQuestionsUrl(event.data.url)) return;
    try {
      if (JSON.stringify(event.data.payload).length > Core.MAX_BODY) return;
      const quiz = Core.parseQuizResponse(event.data.payload);
      observedQuizzes.set(quiz.id, quiz);
      while (observedQuizzes.size > 5) observedQuizzes.delete(observedQuizzes.keys().next().value);
      void registerQuizzes().then(() => { scheduleScan(); }).catch(error => {
        status = { phase: "error", message: error.message, explanation: "" };
      });
    } catch { /* Ignore malformed/untrusted page messages, never pass them directly to AI. */ }
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || (sender.tab && sender.url !== chrome.runtime.getURL("popup.html"))) return false;
    if (message.type === "SC_REFRESH") { void refresh(); respond({ ok: true }); }
    else if (message.type === "SC_RESULTS") { void syncBatch(); respond({ ok: true }); }
    else if (message.type === "SC_TAB_STATUS") respond({ ok: true, data: { ...status, batch: batchStatus } });
    else if (message.type === "SC_RETRY") {
      if (enabled && status.phase !== "loading") { reset(); scan(); }
      respond({ ok: true, data: status });
    }
    return false;
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["value", "role", "hidden", "aria-hidden", "disabled", "aria-disabled", "class", "style"] });
  window.addEventListener("pagehide", () => { reset(); });
  window.addEventListener("pageshow", () => { void refresh(); });
  window.postMessage({ channel, type: "SYNC" }, location.origin);
  void refresh();
})();