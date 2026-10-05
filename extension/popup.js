/* No key or privileged provider configuration is exposed to the page or this UI. */
(() => {
  "use strict";
  const Core = globalThis.SocrativeCore;
  const $ = id => document.getElementById(id);
  const labels = { disabled: "Đã tắt", waiting: "Chờ câu hỏi", loading: "Đang giải", ready: "Có gợi ý",
    error: "Cần kiểm tra", uncertain: "Chưa chắc chắn", unsupported: "Chưa hỗ trợ" };
  let tabId;
  let active = false;
  let busy = false;

  function notify(text, error = false) {
    $("notice").textContent = text;
    $("notice").dataset.error = String(error);
  }

  async function send(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...data });
    if (!response?.ok) throw new Error(response?.error || "Không kết nối được extension.");
    return response.data;
  }

  function renderState(data) {
    active = data.enabled;
    $("enabled").checked = active;
    $("model").textContent = data.model;
    $("api-count").textContent = `${data.apiQuestionCount || 0} câu từ API`;
    renderBatch(data.batch);
  }

  function renderBatch(batch = {}) {
    const total = batch.total || 0;
    const done = (batch.solved || 0) + (batch.uncertain || 0) + (batch.failed || 0) + (batch.skipped || 0);
    $("batch-count").textContent = `${batch.solved || 0} / ${total} có gợi ý`;
    $("batch-progress").max = total || 1;
    $("batch-progress").value = done;
    $("batch-status").textContent = !total ? "Chờ danh sách câu hỏi từ API Socrative." :
      `${batch.active ? "Đang giải" : active ? "Đã xử lý" : "Đã dừng"}: ${done}/${total} câu · ` +
      `${batch.queued || 0} chờ · ${batch.running || 0} đang giải · ${batch.failed || 0} lỗi · ` +
      `${batch.uncertain || 0} chưa chắc · ${batch.skipped || 0} bỏ qua.` + (batch.error ? ` ${batch.error}` : "");
    $("batch-retry").disabled = busy || !active || batch.active || !(batch.failed || batch.uncertain);
  }

  function renderStatus(status) {
    $("phase").textContent = labels[status.phase] ?? "Chờ trang";
    $("phase").dataset.phase = status.phase;
    $("status").textContent = status.message;
    $("source").textContent = status.source ? `Nguồn: ${status.source}` : "";
    $("explanation-wrap").hidden = !status.explanation;
    $("explanation").textContent = status.explanation ?? "";
    $("retry").disabled = busy || !active || !tabId || ["waiting", "loading", "unsupported"].includes(status.phase);
  }

  async function poll() {
    try { renderState(await send("SC_STATE")); } catch (error) { notify(error.message, true); }
    if (!tabId) {
      renderStatus({ phase: "waiting", message: "Mở một bài ôn tập trên Socrative để bắt đầu." });
      return;
    }
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { type: "SC_TAB_STATUS" });
      if (!reply?.ok) throw new Error();
      renderStatus(reply.data);
    } catch {
      renderStatus({ phase: "waiting", message: "Tải lại trang Socrative sau khi cài hoặc cập nhật extension." });
      $("retry").disabled = true;
    }
  }

  async function action(task) {
    if (busy) return;
    busy = true;
    $("enabled").disabled = true;
    $("clear").disabled = true;
    $("retry").disabled = true;
    $("batch-retry").disabled = true;
    try { await task(); }
    catch (error) { notify(error.message, true); }
    finally {
      busy = false;
      $("enabled").disabled = false;
      $("clear").disabled = false;
      $("enabled").checked = active;
      await poll();
    }
  }

  $("enabled").addEventListener("change", () => { void action(async () => {
    renderState(await send("SC_ENABLE", { enabled: $("enabled").checked }));
    notify(active ? "Đã bật. Tự giải toàn bộ câu hỏi từ API Socrative theo batch." : "Đã dừng batch và khôi phục con trỏ gốc.");
  }); });

  $("clear").addEventListener("click", () => { void action(async () => {
    renderState(await send("SC_CLEAR"));
    notify(active ? "Đã xóa bộ nhớ. API đang có trong tab sẽ được giải batch lại." : "Đã xóa hàng đợi và kết quả lưu.");
  }); });

  $("retry").addEventListener("click", () => { void action(async () => {
    await chrome.tabs.sendMessage(tabId, { type: "SC_RETRY" });
    notify("Đã yêu cầu xử lý câu hiện tại. Kết quả hợp lệ có thể được lấy từ bộ nhớ.");
  }); });

  $("batch-retry").addEventListener("click", () => { void action(async () => {
    renderState(await send("SC_BATCH_RETRY"));
    notify("Đã xếp lại câu lỗi/chưa chắc chắn. Những câu thành công không bị giải lại.");
  }); });

  void action(async () => {
    const [data, tabs] = await Promise.all([send("SC_STATE"), chrome.tabs.query({ active: true, currentWindow: true })]);
    renderState(data);
    if (tabs[0] && Core.isSocrativeUrl(tabs[0].url)) tabId = tabs[0].id;
  });
  const timer = setInterval(() => { if (!busy) void poll(); }, 1000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
})();