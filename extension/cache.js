import "./core.js";
export async function cacheId(question, model) {
  const bytes = new TextEncoder().encode(`${model}:v1:${globalThis.SocrativeCore.questionKey(question)}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return "answer:" + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function freshCache(value) {
  return Boolean(value?.result && Date.now() - value.createdAt < 12 * 60 * 60 * 1000);
}