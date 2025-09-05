<script>
  import { onMount } from "svelte";
  import MiniSearch from "minisearch";
  import strip from "strip-accents";

  let query = "";
  let results = [];
  let ms; // MiniSearch en memoria

  let loadingIndex = false;
  let loadingSearch = false;
  let hasSearched = false;
  let statusMsg = "";

  // ---------- UTIL ----------
  const asText = async (res) => new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
  const isHtml = (ct) => (ct || "").toLowerCase().includes("text/html");
  const BASE = import.meta.env.BASE_URL;

  function normalize(s) { return strip(s).toLowerCase(); }

  function buildMiniSearchFromDocs(docs) {
    const mini = new MiniSearch({
      fields: ["norm"],
      storeFields: ["doc", "page", "text"],
      tokenize: str => str.split(/[^a-záéíóúüñ0-9]+/i).filter(Boolean),
      processTerm: t => (t && t.length > 1 ? t : null)
    });
    mini.addAll(docs);
    return mini;
  }

  // ---------- CARGA DEL ÍNDICE ----------
  async function loadIndex() {
    if (ms || loadingIndex) return;
    loadingIndex = true;
    statusMsg = "Cargando índice…";
    try {
      // 0) Intento preferente: manifest + shards (gh-pages)
      const manifestUrl = `${BASE}index/manifest.json`;
      try {
        const mr = await fetch(manifestUrl, { cache: "no-store" });
        if (mr.ok && !isHtml(mr.headers.get("content-type"))) {
          const manifest = await mr.json();
          if (manifest?.shards > 0) {
            const parts = [];
            for (let i = 0; i < manifest.shards; i++) {
              const url = `${BASE}index/index-${i}.json`;
              const res = await fetch(url, { cache: "no-store" });
              if (!res.ok) throw new Error(`No se pudo cargar ${url} (status ${res.status})`);
              const buf = new Uint8Array(await res.arrayBuffer());
              parts.push(buf);
              statusMsg = `Cargando índice… (${i+1}/${manifest.shards})`;
              await Promise.resolve(); // deja pintar UI
            }
            const total = parts.reduce((n, c) => n + c.length, 0);
            const merged = new Uint8Array(total);
            let o = 0; for (const c of parts) { merged.set(c, o); o += c.length; }
            const json = JSON.parse(new TextDecoder().decode(merged));
            ms = MiniSearch.loadJSON(json, { fields: ["norm"], storeFields: ["doc","page","text"] });
            statusMsg = "";
            console.log(`[loadIndex] Índice precompilado (shards=${manifest.shards}) cargado.`);
            return;
          }
        }
      } catch (e) {
        console.warn("[loadIndex] Sin manifest o shards. Intento index-0.json. Motivo:", e);
      }

      // 1) Intento A: índice precompilado simple (index-0.json)
      try {
        const url = `${BASE}index/index-0.json`;
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok && !isHtml(res.headers.get("content-type"))) {
          const txt = await asText(res); // acepta text/plain también
          const json = JSON.parse(txt);
          ms = MiniSearch.loadJSON(json, { fields: ["norm"], storeFields: ["doc","page","text"] });
          statusMsg = "";
          console.log("[loadIndex] Índice precompilado (single) cargado.");
          return;
        } else {
          console.warn(`[loadIndex] ${url} no disponible o devolvió HTML; paso al fallback con docs.jsonl.`);
        }
      } catch (e) {
        console.warn("[loadIndex] Falló índice precompilado (single):", e);
      }

      // 2) Fallback: construir índice en el navegador a partir de docs.jsonl
      statusMsg = "Construyendo índice en el navegador…";
      const res2 = await fetch(`${BASE}build/docs.jsonl`, { cache: "no-store" });
      if (!res2.ok || isHtml(res2.headers.get("content-type"))) {
        statusMsg = 'No se pudo cargar el índice ni los documentos (revisa "public/build/docs.jsonl").';
        console.error("[loadIndex] Fallback: docs.jsonl no disponible.");
        return;
      }
      const txt = await asText(res2);
      const docs = txt.split("\n").filter(Boolean).map(line => {
        const rec = JSON.parse(line);
        return {
          id: rec.id ?? `${rec.doc}#${rec.page}`,
          doc: rec.doc,
          page: rec.page ?? 0,
          text: rec.text ?? "",
          norm: normalize(rec.text ?? "")
        };
      });
      ms = buildMiniSearchFromDocs(docs);
      statusMsg = "";
      console.log(`[loadIndex] Índice construido en cliente a partir de ${docs.length} chunks.`);
    } finally {
      loadingIndex = false;
    }
  }

  // ---------- BÚSQUEDA ----------
  async function doSearch() {
    hasSearched = true;
    if (!ms && !loadingIndex) {
      await loadIndex();
      if (!ms) return;
    }

    const qRaw = query.trim();
    if (!qRaw) {
      results = [];
      statusMsg = "Introduce una búsqueda.";
      return;
    }

    loadingSearch = true;
    statusMsg = "Buscando…";
    await Promise.resolve(); // pinta el estado

    const q = normalize(qRaw);
    const t0 = performance.now();
    results = ms.search(q, {
      prefix: true,
      fuzzy: 0.1,
      combineWith: "AND",
      boost: { norm: 2 }
    }).slice(0, 100);
    const t1 = performance.now();

    loadingSearch = false;
    statusMsg = `${results.length} resultados en ${Math.round(t1 - t0)} ms`;
  }

  // ---------- SNIPPETS ----------
  function snippet(text, q, radius = 160) {
    const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(qEsc, "i");
    const m = re.exec(text);
    if (!m) {
      return { html: escapeHtml(text.slice(0, radius * 2)) + (text.length > radius * 2 ? "…" : "") };
    }
    const i = Math.max(0, m.index - radius);
    const j = Math.min(text.length, m.index + m[0].length + radius);
    const pre = text.slice(i, m.index);
    const hit = text.slice(m.index, m.index + m[0].length);
    const post = text.slice(m.index + m[0].length, j);
    return { html: `${i>0?"…":""}${escapeHtml(pre)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(post)}${j<text.length?"…":""}` };
  }
  function escapeHtml(s){return s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">", "&gt;");}
  export function htmlDirective(node,{html}){node.innerHTML=html;return{update({html}){node.innerHTML=html;}}}

  onMount(loadIndex);
</script>

<svelte:window on:keydown={(e) => { if (e.key === "Enter") doSearch(); }} />

<main class="container">
  <h1>Buscador de PDFs</h1>

  <form class="search" on:submit|preventDefault={doSearch}>
    <input bind:value={query} placeholder="Escribe un término y pulsa Enter" aria-label="Buscar" />
    <button type="submit" on:click|preventDefault={doSearch} disabled={loadingIndex || loadingSearch} aria-busy={loadingIndex || loadingSearch}>
      {#if loadingIndex} Cargando índice… {:else if loadingSearch} Buscando… {:else} Buscar {/if}
    </button>
  </form>

  {#if statusMsg}<p class="muted">{statusMsg}</p>{/if}
  {#if hasSearched && !loadingSearch && results.length === 0 && ms}<p class="muted">Sin resultados.</p>{/if}

  {#if results.length}
    <ul class="results">
      {#each results as r}
        <li class="card">
          <a class="title" href={`${BASE}pdfs/${r.doc}#page=${(r.page ?? 0) + 1}`} target="_blank" rel="noreferrer">
            {r.doc} — pág. {(r.page ?? 0) + 1}
          </a>
          <p class="snippet" use:htmlDirective={{ html: snippet(r.text, query).html }}></p>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  :root { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }
  .container { max-width: 860px; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.8rem; margin-bottom: 1rem; }
  .search { display: flex; gap: .5rem; }
  input { flex: 1; padding: .6rem .8rem; font-size: 1rem; border: 1px solid #ddd; border-radius: .5rem; }
  button { padding: .6rem .9rem; border: 1px solid #ddd; background: #f9f9f9; border-radius: .5rem; cursor: pointer; }
  button[disabled] { opacity: .7; cursor: not-allowed; }
  .muted { color: #666; margin-top: 1rem; }
  .results { list-style: none; padding: 0; margin: 1rem 0 3rem; display: grid; gap: .75rem; }
  .card { padding: .9rem 1rem; border: 1px solid #eee; border-radius: .75rem; background: white; }
  .title { font-weight: 600; text-decoration: none; }
  .title:hover { text-decoration: underline; }
  .snippet { margin: .5rem 0 0; line-height: 1.45; }
  mark { background: #fffd75; }
</style>