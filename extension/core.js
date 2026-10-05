/* Shared, dependency-free validation. Also loaded by Node tests and the service worker. */
(() => {
  "use strict";
  const MAX_BODY = 4 * 1024 * 1024;
  const HOSTS = new Set(["b.socrative.com", "student.socrative.com"]);

  function isSocrativeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && HOSTS.has(url.hostname) && !url.port;
    } catch { return false; }
  }

  function isQuestionsUrl(value) {
    return isSocrativeUrl(value) && /^\/api\/quizzes\/[^/]+\/questions\/?$/.test(new URL(value).pathname);
  }

  function normalizeText(value) {
    if (typeof value !== "string") return "";
    const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
        if (code[0] !== "#") return entities[code.toLowerCase()] ?? match;
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
      }).normalize("NFC").replace(/\s+/gu, " ").trim();
  }

  function id(value) {
    const result = String(value ?? "");
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(result)) throw new Error("ID câu hỏi/đáp án không hợp lệ.");
    return result;
  }

  function text(value, max) {
    if (typeof value !== "string" || value.length > max) throw new Error("Nội dung thiếu hoặc quá dài.");
    return value.normalize("NFC").replace(/\s+/gu, " ").trim();
  }

  function validateQuestion(input) {
    if (!input || typeof input !== "object") throw new Error("Câu hỏi không hợp lệ.");
    if (!Array.isArray(input.answers) || input.answers.length < 2 || input.answers.length > 30) {
      throw new Error("Chỉ hỗ trợ câu hỏi có từ 2 đến 30 lựa chọn.");
    }
    const question = {
      id: id(input.id), quizId: id(input.quizId),
      type: input.type === "MC" || input.type === "TF" ? input.type : "UNSUPPORTED",
      text: text(input.text, 16000), multiple: input.multiple === true,
      hasMedia: input.hasMedia === true,
      answers: input.answers.map(a => ({ id: id(a.id), text: text(a.text, 6000) })),
    };
    if (new Set(question.answers.map(a => a.id)).size !== question.answers.length) {
      throw new Error("ID đáp án bị trùng.");
    }
    if (!question.text && !question.hasMedia) throw new Error("Câu hỏi không có nội dung.");
    if (JSON.stringify(question).length > 64000) throw new Error("Câu hỏi quá lớn.");
    return question;
  }

  function parseQuizResponse(payload) {
    const data = payload?.success === true ? payload.data : null;
    if (!data || !Array.isArray(data.questions) || data.questions.length > 500) {
      throw new Error("Phản hồi API không chứa danh sách câu hỏi hợp lệ.");
    }
    const quizId = id(data.id);
    const questions = [];
    for (const q of data.questions) {
      // Short answer questions have no clickable choices; do not guess for them.
      if (!Array.isArray(q.answers) || q.answers.length < 2) continue;
      questions.push(validateQuestion({
        id: q.questionId, quizId, type: q.type, text: normalizeText(q.questionText),
        multiple: q.allowMultipleAnswers,
        hasMedia: Boolean(q.questionImage || q.questionVideo || q.questionAudio ||
          q.hasOnlyImage || q.hasOnlyMedia || /<(?:img|video|audio)\b/i.test(q.questionText ?? "") ||
          q.answers.some(a => a.image || /<img\b/i.test(a.text ?? ""))),
        answers: q.answers.map(a => ({ id: a.id, text: normalizeText(a.text) })),
      }));
    }
    if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error("ID câu hỏi bị trùng.");
    return { id: quizId, name: normalizeText(data.name ?? "Bài ôn tập").slice(0, 200), questions };
  }

  function validateQuizzes(input) {
    if (!Array.isArray(input) || input.length > 10) throw new Error("Chỉ xử lý tối đa 10 bài mỗi lần.");
    let count = 0;
    return input.map(quiz => {
      if (!Array.isArray(quiz.questions) || (count += quiz.questions.length) > 1000) {
        throw new Error("Chỉ xử lý tối đa 1.000 câu hỏi có lựa chọn.");
      }
      return { id: id(quiz.id), name: text(quiz.name, 200), questions: quiz.questions.map(validateQuestion) };
    });
  }

  function questionKey(question) {
    const q = validateQuestion(question);
    // Independent of display order; never map by A/B/C/D.
    return JSON.stringify([q.type, q.text, q.multiple, q.hasMedia,
      q.answers.slice().sort((a, b) => a.id.localeCompare(b.id)).map(a => [a.id, a.text])]);
  }

  function matchQuestion(questions, optionIds, questionText) {
    const ids = new Set(optionIds);
    if (ids.size !== optionIds.length) return null;
    return questions.find(q => q.text === questionText && q.answers.length === ids.size &&
      q.answers.every(a => ids.has(a.id))) ?? null;
  }

  function matchQuestionByText(questions, optionTexts, questionText, multiple) {
    const texts = new Set(optionTexts);
    if (texts.size !== optionTexts.length || texts.has("")) return null;
    const candidates = questions.filter(q => q.text === questionText && q.multiple === multiple &&
      q.answers.length === texts.size && new Set(q.answers.map(a => a.text)).size === texts.size &&
      q.answers.every(a => texts.has(a.text)));
    // Different API responses must agree on IDs and content; never guess when ambiguous.
    const unique = new Map(candidates.map(q => [questionKey(q), q]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  }

  function parseAIAnswer(content, question) {
    if (typeof content !== "string" || content.length > 32000) throw new Error("AI không trả về nội dung hợp lệ.");
    const clean = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let result;
    try { result = JSON.parse(clean); } catch { throw new Error("AI không trả về JSON hợp lệ. Bạn có thể thử lại."); }
    if (!result || String(result.questionId) !== question.id || typeof result.abstain !== "boolean" ||
        !Array.isArray(result.answerIds) || result.answerIds.some(a => typeof a !== "string")) {
      throw new Error("Kết quả AI không đúng cấu trúc câu hỏi.");
    }
    const allowed = new Set(question.answers.map(a => a.id));
    const selected = new Set(result.answerIds);
    if (selected.size !== result.answerIds.length || result.answerIds.some(a => !allowed.has(a)) ||
        (result.abstain ? selected.size !== 0 : selected.size === 0 || (!question.multiple && selected.size !== 1))) {
      throw new Error("AI trả về ID hoặc số lượng đáp án không hợp lệ.");
    }
    return { answerIds: [...selected], abstain: result.abstain,
      explanation: typeof result.explanation === "string" ? result.explanation.slice(0, 1600) : "" };
  }

  function parseAIBatch(content, questions) {
    if (typeof content !== "string" || content.length > 100000) throw new Error("Batch AI không hợp lệ.");
    let data;
    try { data = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new Error("Batch AI không trả về JSON hợp lệ."); }
    const allowed = new Set(questions.map(q => q.id));
    if (!Array.isArray(data?.results) || data.results.length > questions.length ||
        data.results.some(r => !r || typeof r.questionId !== "string" || !allowed.has(r.questionId))) {
      throw new Error("Batch AI trả về danh sách hoặc ID câu hỏi không hợp lệ.");
    }
    return questions.map(q => {
      const matches = data.results.filter(r => r.questionId === q.id);
      try {
        if (matches.length !== 1) throw new Error("AI bỏ sót hoặc trả trùng câu hỏi trong batch.");
        return { questionId: q.id, result: parseAIAnswer(JSON.stringify(matches[0]), q) };
      } catch (error) { return { questionId: q.id, error: error.message }; }
    });
  }

  globalThis.SocrativeCore = Object.freeze({ MAX_BODY, isSocrativeUrl, isQuestionsUrl, normalizeText,
    validateQuestion, parseQuizResponse, validateQuizzes, questionKey, matchQuestion, matchQuestionByText, parseAIAnswer, parseAIBatch });
})();