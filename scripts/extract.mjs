// scripts/extract.mjs — v3 (POPPLER): pdfinfo + pdftotext, secuencial, watchdog y reanudación
// Requisitos: tener 'pdfinfo' y 'pdftotext' en PATH (brew install poppler, o conda)
// Banner para confirmar que usas Poppler:
console.log("[extract] USANDO POPPLER (pdfinfo/pdftotext)");

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// === Config ===
const SRC = path.resolve("public/pdfs");
const OUT_DIR = path.resolve("public/build");
const OUT_FILE = path.join(OUT_DIR, "docs.jsonl");
const ERR_LOG = path.join(OUT_DIR, "errors.log");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

// Tiempo máx. por comando (ms)
const INFO_TIMEOUT_MS = 15000;
const PAGE_TIMEOUT_MS = 20000;

// Modo lote (para probar en tandas): procesa solo los primeros N PDFs (0 = sin límite)
const LIMIT = Number(process.env.LIMIT || 0);

function normalizeText(s) {
  return s?.normalize("NFD")?.replace(/[\u0300-\u036f]/g, "")?.toLowerCase() ?? "";
}

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function append(file, text) { await fs.writeFile(file, text, { flag: "a" }); }

async function loadManifest() {
  try { return JSON.parse(await fs.readFile(MANIFEST, "utf8")); }
  catch { return { done: {}, lastId: 0 }; }
}
async function saveManifest(m) { await fs.writeFile(MANIFEST, JSON.stringify(m, null, 2)); }

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = [];
    let err = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);

    child.stdout.on("data", c => out.push(c));
    child.stderr.on("data", c => err.push(c));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `Command failed: ${cmd} ${args.join(" ")}`));
    });
  });
}

async function getPageCount(pdfPath) {
  const { stdout } = await run("pdfinfo", [pdfPath], INFO_TIMEOUT_MS);
  const m = stdout.match(/Pages:\s+(\d+)/i);
  const pages = m ? parseInt(m[1], 10) : null;
  if (!pages || pages < 1) throw new Error("pages=0");
  return pages;
}

async function extractPageText(pdfPath, pageNum) {
  // -layout mantiene algo de estructura; -nopgbrk evita saltos de página ASCII
  const args = ["-enc","UTF-8","-layout","-nopgbrk","-f", String(pageNum), "-l", String(pageNum), pdfPath, "-"];
  const { stdout } = await run("pdftotext", args, PAGE_TIMEOUT_MS);
  return stdout.replace(/\s+/g, " ").trim();
}

async function main() {
  await ensureDir(OUT_DIR);
  await fs.writeFile(OUT_FILE, "", { flag: "a" });
  await fs.writeFile(ERR_LOG, "", { flag: "a" });

  const all = (await fs.readdir(SRC)).filter(f => f.toLowerCase().endsWith(".pdf")).sort();
  if (!all.length) {
    console.error("[extract] No hay PDFs en public/pdfs");
    process.exit(1);
  }

  const manifest = await loadManifest();
  let id = manifest.lastId || 0;
  const done = new Set(Object.keys(manifest.done || {}));

  const pendingAll = all.filter(f => !done.has(f));
  const pending = LIMIT > 0 ? pendingAll.slice(0, LIMIT) : pendingAll;

  console.log(`[extract] Total PDFs: ${all.length} — Pendientes: ${pendingAll.length} ${LIMIT>0?`(procesando solo ${pending.length})`:""}`);

  const t0 = Date.now();
  let ok = 0, fail = 0;

  for (let idx = 0; idx < pending.length; idx++) {
    const file = pending[idx];
    const abs = path.join(SRC, file);
    process.stdout.write(`[extract] (${idx+1}/${pending.length}) ${file} ... `);

    let pages = 0;
    try {
      pages = await getPageCount(abs);
    } catch (e) {
      await append(ERR_LOG, `${file}\tpdfinfo\t${e.message}\n`);
      manifest.done[file] = { status: "error", step: "pdfinfo", reason: e.message };
      fail++;
      console.log("pdfinfo:ERROR");
      continue;
    }

    let emitted = 0;
    for (let p = 1; p <= pages; p++) {
      try {
        const text = await extractPageText(abs, p);
        if (!text) continue;
        const rec = { id: id++, doc: file, page: p-1, text, norm: normalizeText(text) };
        await append(OUT_FILE, JSON.stringify(rec) + "\n");
        emitted++;
      } catch (e) {
        await append(ERR_LOG, `${file}\tpdftotext(page=${p})\t${e.message}\n`);
        // sigue con la siguiente página
      }
    }

    manifest.done[file] = { status: "ok", pages, emitted };
    ok++;
    console.log(`OK (${emitted}/${pages})`);

    // guarda progreso cada 10 archivos
    if ((ok + fail) % 10 === 0) {
      manifest.lastId = id;
      await saveManifest(manifest);
      const secs = Math.round((Date.now() - t0) / 1000);
      console.log(`[extract] Progreso: ${ok} OK, ${fail} errores — ${secs}s`);
    }
  }

  manifest.lastId = id;
  await saveManifest(manifest);

  const outStat = await fs.stat(OUT_FILE);
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`[extract] FIN — OK: ${ok}, errores: ${fail} — ${secs}s`);
  console.log(`[extract] -> ${OUT_FILE} (${outStat.size} bytes)`);
  console.log(`[extract] Manifest -> ${MANIFEST}`);
  if (fail) console.log(`[extract] Errores -> ${ERR_LOG}`);
}

main().catch(e => {
  console.error("[extract] FATAL:", e);
  process.exit(1);
});
