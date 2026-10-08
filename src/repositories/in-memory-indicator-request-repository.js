const VALID_DECISIONS = new Set(["GRANTED", "DENIED"]);

function copyRecord(record) {
  return record == null ? null : structuredClone(record);
}

function timestampKey(value) {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function recentTimestamp(record) {
  return [record.requestedAt, record.decidedAt].map(timestampKey).sort().at(-1) ?? "";
}

function notFoundError() {
  const error = new Error("Indicator request not found");
  error.code = "INDICATOR_REQUEST_NOT_FOUND";
  return error;
}

function notPendingError() {
  const error = new Error("Indicator request is not pending");
  error.code = "INDICATOR_REQUEST_NOT_PENDING";
  return error;
}

export function createInMemoryIndicatorRequestRepository({ now = () => new Date().toISOString() } = {}) {
  const byUserId = new Map();

  return {
    upsertPending(input) {
      const userId = String(input.userId);
      const existing = byUserId.get(userId);
      const record = {
        ...(existing ?? {}),
        ...structuredClone(input),
        userId,
        indicatorIds: [...(input.indicatorIds ?? [])],
        status: "PENDING",
        requestedAt: now(),
        decidedBy: null,
        decidedAt: null,
      };
      byUserId.set(userId, record);
      return copyRecord(record);
    },

    findByUserId(userId) {
      return copyRecord(byUserId.get(String(userId)));
    },

    list() {
      return [...byUserId.values()]
        .sort((a, b) => recentTimestamp(b).localeCompare(recentTimestamp(a)))
        .map(copyRecord);
    },

    decide({ userId, status, actorId }) {
      if (!VALID_DECISIONS.has(status)) {
        const error = new Error("Invalid indicator request decision");
        error.code = "INVALID_DECISION";
        throw error;
      }
      const key = String(userId);
      const existing = byUserId.get(key);
      if (!existing) throw notFoundError();
      if (existing.status !== "PENDING") throw notPendingError();
      const record = {
        ...existing,
        status,
        decidedBy: String(actorId),
        decidedAt: now(),
      };
      byUserId.set(key, record);
      return copyRecord(record);
    },
  };
}
