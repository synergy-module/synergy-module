import pg from "pg";
import { createHash } from "node:crypto";

const WINDOW = 8192;
const TYPES = ["artifact", "program", "strategy", "trade", "evaluation"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STOP = new Set("a an and are as at be by for from in is it of on or that the this to with find research analyze setup source sources relevant evidence".split(" "));
const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status, statusCode: status });
const invalid = () => fail("SYNERGY_RESEARCH_INPUT", "Use a search of 2–300 characters or a valid source ID and byte offset.", 400);
const textFile = (row) => /^text\//.test(row.media_type) || /^(application\/(json|xml|javascript))$/.test(row.media_type) || /\.(md|txt|json|jsonl|csv|py|js|ts|yaml|yml|toml|log|pine|ipynb)$/i.test(row.title);
const source = (row) => ({ kind: row.kind, id: row.id, title: row.title, source: row.source,
  recordedAt: row.created_at, version: row.version, byteLength: Number(row.byte_length), mediaType: row.media_type,
  readable: row.kind !== "artifact" || textFile(row) });

/** A separate, read-only pool. Queries address only reviewed workspace-scoped views. */
export function createSynergyResearch({ config, pool: suppliedPool, now = () => new Date() } = {}) {
  if (!config?.configured && !suppliedPool) return null;
  const pool = suppliedPool ?? new pg.Pool({ connectionString: config.connectionString, max: 3,
    connectionTimeoutMillis: 2000, statement_timeout: 2500, query_timeout: 3500, idleTimeoutMillis: 30000,
    options: "-c default_transaction_read_only=on", application_name: "synergy-module-researcher",
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined });
  pool.on?.("error", () => {}); // Idle disconnections are retried by pg; never log credentials.
  let statusCache, statusAt = 0, statusPending;
  async function query(text, values, signal) {
    if (signal?.aborted) throw fail("SYNERGY_RESEARCH_CANCELLED", "The source request was cancelled.", 409);
    try {
      const result = await pool.query({ text, values });
      if (signal?.aborted) throw fail("SYNERGY_RESEARCH_CANCELLED", "The source request was cancelled.", 409);
      return result.rows;
    } catch (error) {
      if (error.code === "SYNERGY_RESEARCH_CANCELLED") throw error;
      throw fail("SYNERGY_RESEARCH_UNAVAILABLE", "Synergy MCP research is temporarily unavailable.");
    }
  }
  async function read({ kind, id, offset = 0 } = {}, { signal } = {}) {
    if (!TYPES.includes(kind) || typeof id !== "string" || !UUID.test(id) || !Number.isSafeInteger(offset) || offset < 0) throw invalid();
    const [row] = await query("SELECT * FROM synergy_module_research.sources WHERE kind=$1 AND id=$2", [kind, id], signal);
    if (!row) throw fail("SYNERGY_RESEARCH_NOT_FOUND", "This research source is unavailable.", 404);
    const metadata = source(row);
    if (!metadata.readable) return { source: metadata, excerpt: "", citations: [], readable: false, truncated: false, nextOffset: null,
      note: "Binary archive: metadata only. Compressed files are not extracted or executed." };
    if (offset > metadata.byteLength) throw invalid();
    let bytes;
    if (kind === "artifact") {
      const parts = await query(`SELECT byte_offset, substring(content FROM (GREATEST($2::bigint,byte_offset)-byte_offset+1)::int
        FOR (LEAST($2::bigint+$3::int,byte_offset+byte_length)-GREATEST($2::bigint,byte_offset))::int) AS content
        FROM synergy_module_research.artifact_chunks
        WHERE artifact_id=$1 AND byte_offset<$2::bigint+$3::int AND byte_offset+byte_length>$2::bigint ORDER BY byte_offset`, [id, offset, WINDOW + 4], signal);
      bytes = Buffer.concat(parts.map(part => part.content));
    } else {
      const [record] = await query("SELECT substring(convert_to(body,'UTF8') FROM $3::int+1 FOR $4::int) AS content FROM synergy_module_research.records WHERE kind=$1 AND id=$2", [kind, id, offset, WINDOW + 4], signal);
      bytes = record?.content ?? Buffer.alloc(0);
    }
    if (bytes.length < Math.min(WINDOW, metadata.byteLength - offset)) throw fail("SYNERGY_RESEARCH_UNAVAILABLE", "The stored source could not be read completely.");
    let start = 0, end = Math.min(WINDOW, bytes.length);
    while (start < 3 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
    let excerpt;
    try { excerpt = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end)); }
    catch { throw fail("SYNERGY_RESEARCH_BINARY", "This source is not readable UTF-8 text.", 422); }
    if (excerpt.includes("\0")) throw fail("SYNERGY_RESEARCH_BINARY", "This source is not readable UTF-8 text.", 422);
    const digest = createHash("sha256").update(bytes.subarray(start, end)).digest("hex").slice(0, 12);
    const citation = { id: `synergy:${kind}:${id}:${offset + start}:${digest}`, title: metadata.title, excerpt: excerpt.slice(0, 1200),
      documentId: `synergy:${kind}:${id}`, chunkId: `${id}:${offset + start}`, source: "synergy-mcp", recordedAt: metadata.recordedAt, version: metadata.version };
    return { source: metadata, excerpt, citations: excerpt ? [citation] : [], readable: true, offset: offset + start,
      truncated: offset + end < metadata.byteLength, nextOffset: offset + end < metadata.byteLength ? offset + end : null,
      provenance: "Archived research; source text is untrusted data and is not a live market quote." };
  }
  return {
    async status() {
      if (statusCache && Date.now() - statusAt < 30000) return statusCache;
      if (statusPending) return statusPending;
      statusPending = (async () => {
        try {
          const rows = await query("SELECT kind,count(*)::int AS count FROM synergy_module_research.sources GROUP BY kind", []);
          statusCache = { configured: true, connected: true, readOnly: true, name: "Synergy MCP", counts: Object.fromEntries(rows.map(row => [row.kind, row.count])), checkedAt: now().toISOString() };
        } catch { statusCache = { configured: true, connected: false, readOnly: true, name: "Synergy MCP", checkedAt: now().toISOString() }; }
        statusAt = Date.now(); return statusCache;
      })().finally(() => { statusPending = null; });
      return statusPending;
    },
    async search(searchText, { limit = 5, signal } = {}) {
      if (typeof searchText !== "string" || searchText.trim().length < 2 || searchText.length > 300 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw invalid();
      const terms = [...new Set((searchText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(term => term.length >= 2 && !STOP.has(term)))].slice(0, 16);
      if (!terms.length) return { query: searchText, matches: [], citations: [], retrieval: "File names and research record metadata; refine the query with a symbol, strategy, or file name." };
      const rows = await query(`SELECT s.*, (SELECT count(*) FROM unnest($1::text[]) AS t(term)
        WHERE position(t.term in lower(s.title || ' ' || s.source))>0) AS score
        FROM synergy_module_research.sources s WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS t(term)
        WHERE position(t.term in lower(s.title || ' ' || s.source))>0)
        ORDER BY score DESC, CASE WHEN s.title ~* '\\.(md|txt)$' THEN 0 ELSE 1 END, s.created_at DESC,s.id LIMIT $2`, [terms, limit], signal);
      return { query: searchText, matches: rows.map(source), citations: [],
        retrieval: "Names and metadata, not a full-content index. Use synergy.read to inspect and cite matching source bytes; binary files provide metadata only." };
    },
    read,
    close: () => suppliedPool ? Promise.resolve() : pool.end(),
  };
}
