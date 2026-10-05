import { readFile, readdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url);
const extension = new URL("extension/", root);
const manifest = JSON.parse(await readFile(new URL("manifest.json", extension), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["storage", "alarms"]);
assert.equal(manifest.web_accessible_resources, undefined);
assert.equal(manifest.externally_connectable, undefined);
const references = [manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap(s => [...(s.js ?? []), ...(s.css ?? [])])];
for (const path of references) await access(new URL(path, extension));
for (const dir of [extension, new URL("scripts/", root), new URL("tests/", root)]) {
  for (const name of await readdir(dir)) {
    if (!/\.(?:js|mjs)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(name, dir))], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
}
const { AI_CONFIG } = await import(new URL("config.private.js", extension));
assert.equal(AI_CONFIG.baseUrl, "https://gatecheap.vn/v1");
assert.equal(AI_CONFIG.model, "gpt-6.1-sol");
assert.equal(typeof AI_CONFIG.apiKey, "string");
assert.ok(AI_CONFIG.apiKey.length > 10);
const ignore = await readFile(new URL(".gitignore", root), "utf8");
assert.ok(ignore.includes("extension/config.private.js"));
for (const name of await readdir(extension)) {
  if (name === "config.private.js") continue;
  const source = await readFile(new URL(name, extension), "utf8");
  assert.ok(!source.includes(AI_CONFIG.apiKey), `Credential leak in ${name}`);
  assert.doesNotMatch(source, /\bHAR\b|parseHar|SC_IMPORT|importedCount|import-count|file-button|type=["']file["']/i,
    `Removed file import feature in ${name}`);
}
const html = await readFile(new URL("popup.html", extension), "utf8");
const css = await readFile(new URL("popup.css", extension), "utf8");
assert.ok(!/<script[^>]*>\s*\S+(?!<\/script)/i.test(html.replace(/<script[^>]*src=[^>]*><\/script>/g, "")), "No inline scripts");
assert.ok(css.includes(":focus-visible"));
console.log("PASS: syntax, manifest references, least-privilege permissions, private config isolation, popup assets, API-only extension.");