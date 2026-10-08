const invalid = () => Object.assign(new Error("Invalid history cursor or page size"), { code: "BRAIN_INVALID_INPUT" });

export function readBrainPage(query, kind, fallback) {
  const rawLimit = query?.limit;
  if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^[1-9]\d?$/.test(rawLimit))) throw invalid();
  const limit = rawLimit === undefined ? fallback : Number(rawLimit);
  if (limit > 50) throw invalid();
  if (query?.cursor === undefined) return { limit };
  const cursor = query.cursor;
  if (typeof cursor !== "string" || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || decoded.v !== 1 || decoded.kind !== kind || Object.keys(decoded).length !== 4
      || typeof decoded.id !== "string" || !decoded.id.trim() || decoded.id.length > 256
      || typeof decoded.updatedAt !== "string" || new Date(decoded.updatedAt).toISOString() !== decoded.updatedAt) throw invalid();
    return { limit, before: { updatedAt: decoded.updatedAt, id: decoded.id } };
  } catch { throw invalid(); }
}

export function brainPage(rows, kind, limit) {
  const items = rows.slice(0, limit), last = items.at(-1);
  const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, kind, updatedAt: last.updatedAt, id: last.id })).toString("base64url") : null;
  return { [kind]: items, nextCursor };
}
