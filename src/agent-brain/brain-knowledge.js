import { randomUUID } from "node:crypto";

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 100;
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "with"]);

function tokens(text) {
  return (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => !STOP_WORDS.has(term));
}

function chunks(document) {
  const result = [];
  let start = 0;
  while (start < document.text.length) {
    let end = Math.min(start + CHUNK_SIZE, document.text.length);
    if (end < document.text.length) {
      const lastSpace = document.text.lastIndexOf(" ", end);
      if (lastSpace > start + CHUNK_SIZE / 2) end = lastSpace;
    }
    const excerpt = document.text.slice(start, end).trim();
    if (excerpt) result.push({ documentId: document.id, chunkId: `${document.id}:${result.length}`,
      title: document.title, kind: document.kind, excerpt });
    if (end === document.text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return result;
}

function summary(document) {
  return { id: document.id, title: document.title, kind: document.kind,
    createdAt: document.createdAt, updatedAt: document.updatedAt,
    characters: document.text.length, chunkCount: chunks(document).length };
}

export function createBrainKnowledge({ repository }) {
  if (!repository) throw new TypeError("Brain knowledge requires a repository");
  return {
    async addDocument(ownerId, { title, text, kind = "knowledge" } = {}) {
      const document = await repository.putDocument(ownerId, { id: randomUUID(), title, text, kind });
      return summary(document);
    },
    async removeDocument(ownerId, id) {
      await repository.deleteDocument(ownerId, id);
    },
    async listDocuments(ownerId, options) {
      return (await repository.listDocuments(ownerId, options)).map(summary);
    },
    async search(ownerId, query, { limit = 5, kind } = {}) {
      if (typeof query !== "string" || query.length > 4000 || (kind !== undefined && !["knowledge", "memory"].includes(kind))) {
        throw Object.assign(new Error("Search query must contain at most 4,000 characters"), {
          code: "BRAIN_INVALID_INPUT", status: 400, statusCode: 400,
        });
      }
      const terms = [...new Set(tokens(query))].slice(0, 64);
      if (!terms.length) return [];
      // PostgreSQL selects an indexed, tenant-scoped candidate set first. Its
      // scores are candidate-local; local repositories retain full-corpus BM25.
      // Both paths return only positive lexical matches and verbatim citations.
      const documents = typeof repository.searchDocuments === "function"
        ? await repository.searchDocuments(ownerId, terms, { kind, limit: 64 })
        : (await repository.listDocuments(ownerId)).filter((document) => kind === undefined || document.kind === kind);
      const candidates = documents.flatMap(chunks).map((chunk) => {
        // Title terms have a modest boost; all excerpts remain verbatim source
        // text. This is lexical retrieval, with no embeddings or model calls.
        const words = [...tokens(chunk.excerpt), ...tokens(chunk.title), ...tokens(chunk.title)];
        const frequencies = new Map();
        for (const term of words) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
        return { chunk, frequencies, length: Math.max(1, words.length) };
      });
      if (!candidates.length) return [];
      const averageLength = candidates.reduce((sum, row) => sum + row.length, 0) / candidates.length;
      const documentFrequencies = new Map(terms.map((term) => [term,
        candidates.reduce((count, row) => count + Number(row.frequencies.has(term)), 0)]));
      const scored = candidates.map(({ chunk, frequencies, length }) => {
        let score = 0;
        for (const term of terms) {
          const frequency = frequencies.get(term) ?? 0;
          if (!frequency) continue;
          const containing = documentFrequencies.get(term);
          const idf = Math.log(1 + (candidates.length - containing + 0.5) / (containing + 0.5));
          score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length / averageLength));
        }
        return { ...chunk, score: Number(score.toFixed(6)) };
      });
      const maximum = Number.isInteger(limit) ? Math.max(1, Math.min(10, limit)) : 5;
      return scored.filter((chunk) => chunk.score > 0)
        .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId) || left.chunkId.localeCompare(right.chunkId))
        .slice(0, maximum);
    },
  };
}
