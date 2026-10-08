import { randomUUID } from "node:crypto";
import { createJournalEntry } from "../../public/js/journal/journal-entry.js";

function stringValue(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizeInput(body = {}) {
  if (body.direction !== "long" && body.direction !== "short") {
    const error = new Error("direction must be long or short");
    error.code = "JOURNAL_INPUT_INVALID";
    throw error;
  }
  return {
    direction: body.direction,
    entryTime: stringValue(body.entryTime, 80),
    entryPrice: stringValue(body.entryPrice, 80),
    exitPrice: stringValue(body.exitPrice, 80),
    notes: stringValue(body.notes, 10_000),
    confluences: Array.isArray(body.confluences)
      ? body.confluences.filter((value) => typeof value === "string").slice(0, 32).map((value) => value.slice(0, 120))
      : [],
    screenshotCount: Number.isInteger(body.screenshotCount)
      ? Math.max(0, Math.min(body.screenshotCount, 20))
      : 0,
  };
}

export function createJournalApiController({ journalRepository, clock = () => new Date(), idFactory = randomUUID }) {
  return {
    async list(req, res, next) {
      try {
        return res.json({ entries: await journalRepository.list(req.session.operator.id) });
      } catch (error) { return next(error); }
    },
    async find(req, res, next) {
      try {
        const entry = await journalRepository.find(req.session.operator.id, req.params.id);
        return entry ? res.json({ entry }) : res.status(404).json({ error: "JOURNAL_ENTRY_NOT_FOUND" });
      } catch (error) { return next(error); }
    },
    async create(req, res, next) {
      try {
        const input = normalizeInput(req.body);
        const entry = createJournalEntry(input, { id: idFactory(), createdAt: clock().toISOString() });
        await journalRepository.create(req.session.operator.id, entry);
        return res.status(201).json({ entry });
      } catch (error) {
        if (error.code === "JOURNAL_INPUT_INVALID") {
          return res.status(422).json({ error: error.code, message: "JOURNAL ENTRY IS INVALID" });
        }
        return next(error);
      }
    },
  };
}
