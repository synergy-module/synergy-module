const DEFAULT_KEY = "synergy-module.journal.v1";
const LEGACY_KEY = "omensite.journal.v1";

function safeString(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function normalizeJournalEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if ((typeof entry.id !== "string" && typeof entry.id !== "number") || String(entry.id).trim() === "") return null;
  if (entry.direction !== "long" && entry.direction !== "short") return null;
  return {
    ...entry,
    direction: entry.direction,
    entryTime: safeString(entry.entryTime, "--"),
    entryPrice: safeString(entry.entryPrice, "0"),
    exitPrice: safeString(entry.exitPrice, "0"),
    pl: safeString(entry.pl, "+0.00"),
    notes: safeString(entry.notes, ""),
    confluences: Array.isArray(entry.confluences) ? entry.confluences.filter((value) => typeof value === "string") : [],
    screenshotCount: Number.isInteger(entry.screenshotCount) && entry.screenshotCount >= 0 ? entry.screenshotCount : 0,
    createdAt: safeString(entry.createdAt, ""),
  };
}

export class LocalStorageJournalRepository {
  constructor(storage, key = DEFAULT_KEY) {
    this.storage = storage;
    this.key = key;
    this.entries = [];
    this.persistenceAvailable = true;
  }

  list() {
    if (!this.persistenceAvailable) return this.entries;
    try {
      let raw = this.storage.getItem(this.key);
      const migrate = raw == null && this.key === DEFAULT_KEY;
      if (migrate) raw = this.storage.getItem(LEGACY_KEY);
      const entries = raw ? JSON.parse(raw) : [];
      this.entries = Array.isArray(entries) ? entries.map(normalizeJournalEntry).filter(Boolean) : [];
      if (migrate && raw != null) {
        // Copy before removing the legacy value so denied writes cannot lose saved trades.
        this.storage.setItem(this.key, raw);
        this.storage.removeItem(LEGACY_KEY);
      }
      return this.entries;
    } catch {
      this.persistenceAvailable = false;
      return this.entries;
    }
  }

  find(id) {
    return this.list().find((entry) => String(entry.id) === String(id));
  }

  create(entry) {
    const entries = [entry, ...this.list()];
    this.entries = entries;
    try {
      this.storage.setItem(this.key, JSON.stringify(entries));
    } catch {
      this.persistenceAvailable = false;
    }
    return entry;
  }

  clear() {
    this.entries = [];
    try {
      if (this.key === DEFAULT_KEY) this.storage.removeItem(LEGACY_KEY);
      this.storage.removeItem(this.key);
    } catch {
      this.persistenceAvailable = false;
    }
  }
}
