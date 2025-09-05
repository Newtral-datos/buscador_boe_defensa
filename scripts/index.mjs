// scripts/index.mjs — shards + manifest
import fs from "node:fs/promises";
import path from "node:path";
import MiniSearch from "minisearch";

const IN_FILE  = path.resolve("public/build/docs.jsonl");
const OUT_DIR  = path.resolve("public/index");
const SHARD_BYTES = 5 * 1024 * 1024; // ~5 MB por shard

await fs.mkdir(OUT_DIR, { recursive: true });

// lee docs.jsonl
let text;
try {
  text = await fs.readFile(IN_FILE, "utf8");
} catch {
  console.error(`[index] No existe ${IN_FILE}. Ejecuta primero: npm run extract`);
  process.exit(1);
}
const lines = text.split("\n").filter(Boolean).map(JSON.parse);
console.log("[index] Registros a indexar:", lines.length);
if (!lines.length) {
  console.error("[index] docs.jsonl está vacío.");
  process.exit(1);
}

// construye MiniSearch
const ms = new MiniSearch({
  fields: ["norm"],
  storeFields: ["doc", "page", "text"],
  tokenize: s => s.split(/[^a-záéíóúüñ0-9]+/i).filter(Boolean),
  processTerm: t => (t && t.length > 1 ? t : null),
});
ms.addAll(lines);

// serializa y parte
const json = JSON.stringify(ms.toJSON());
const buf = Buffer.from(json, "utf8");
let shards = 0;
for (let i = 0; i < buf.length; i += SHARD_BYTES) {
  const slice = buf.subarray(i, i + SHARD_BYTES);
  const file = path.join(OUT_DIR, `index-${shards}.json`);
  await fs.writeFile(file, slice);
  console.log(`[index] shard ${shards} -> ${file} (${slice.length} bytes)`);
  shards++;
}

// manifest
const manifest = {
  version: 1,
  totalBytes: buf.length,
  shards,
  shardBytes: SHARD_BYTES
};
await fs.writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest), "utf8");
console.log(`[index] OK -> ${shards} shard(s) + manifest en ${OUT_DIR}`);
