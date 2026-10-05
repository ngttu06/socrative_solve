/* Runs in MAIN world. No credentials, extension APIs, or AI access exist here. */
(() => {
  "use strict";
  const marker = "__socrativeCursorHookV1";
  if (window[marker]) return;
  Object.defineProperty(window, marker, { value: true });
  const latest = new Map();
  const MAX = 4 * 1024 * 1024;
  const channel = "socrative-cursor-v1";

  function allowed(value) {
    try {
      const url = new URL(value, location.href);
      return url.protocol === "https:" && !url.port && ["student.socrative.com", "b.socrative.com"].includes(url.hostname) &&
        /^\/api\/quizzes\/[^/]+\/questions\/?$/.test(url.pathname);
    } catch { return false; }
  }

  function publish(url, payload) {
    if (!payload?.success || !Array.isArray(payload.data?.questions) || payload.data.questions.length > 500) return;
    // Explicit allowlist: never forward request headers, cookies, tokens, or room/student metadata.
    const data = { id: payload.data.id, name: payload.data.name,
      questions: payload.data.questions.map(q => ({
        questionId: q.questionId, type: q.type, questionText: q.questionText,
        allowMultipleAnswers: q.allowMultipleAnswers, questionImage: q.questionImage,
        questionAudio: q.questionAudio, questionVideo: q.questionVideo,
        hasOnlyImage: q.hasOnlyImage, hasOnlyMedia: q.hasOnlyMedia,
        answers: Array.isArray(q.answers) ? q.answers.map(a => ({ id: a.id, text: a.text, image: a.image })) : [],
      })) };
    const safeUrl = new URL(url, location.href);
    const entry = { channel, type: "QUIZ", url: safeUrl.origin + safeUrl.pathname, payload: { success: true, data } };
    if (JSON.stringify(entry).length > MAX) return;
    latest.set(String(data.id), entry);
    while (latest.size > 5) latest.delete(latest.keys().next().value);
    window.postMessage(entry, location.origin);
  }

  async function capture(response, url) {
    if (!allowed(url) || ![200, 304].includes(response.status) || !response.body) return;
    if (Number(response.headers.get("content-length")) > MAX) return;
    const clone = response.clone();
    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let body = "", bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((bytes += value.byteLength) > MAX) { void reader.cancel(); return; }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    if (body) publish(url, JSON.parse(body));
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = Reflect.apply(originalFetch, this, args);
    promise.then(response => {
      const url = response.url || (args[0] instanceof Request ? args[0].url : String(args[0]));
      void capture(response, url).catch(() => {});
    }, () => {});
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    urls.set(this, String(url));
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = urls.get(this);
    if (allowed(url)) this.addEventListener("load", () => {
      try {
        if (![200, 304].includes(this.status)) return;
        if (this.responseType === "json") publish(url, this.response);
        else if ((!this.responseType || this.responseType === "text") && this.responseText.length <= MAX) {
          publish(url, JSON.parse(this.responseText));
        }
      } catch { /* Observation must never break the host application's request. */ }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };

  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === channel && event.data.type === "SYNC") {
      for (const entry of latest.values()) window.postMessage(entry, location.origin);
    }
  });
})();