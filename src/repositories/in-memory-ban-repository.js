function copyRecord(record) {
  return record == null ? null : structuredClone(record);
}

function timestampKey(value) {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function userIdFrom(input) {
  return String(typeof input === "object" && input !== null ? input.userId : input);
}

export function createInMemoryBanRepository({ now = () => new Date().toISOString() } = {}) {
  const byUserId = new Map();

  return {
    ban(input) {
      const record = {
        ...structuredClone(input),
        userId: String(input.userId),
        actorId: String(input.actorId),
        bannedAt: now(),
      };
      byUserId.set(record.userId, record);
      return copyRecord(record);
    },

    unban(input) {
      const userId = userIdFrom(input);
      const record = byUserId.get(userId);
      if (!record) {
        const error = new Error("Ban record not found");
        error.code = "BAN_NOT_FOUND";
        throw error;
      }
      byUserId.delete(userId);
      return copyRecord(record);
    },

    findByUserId(userId) {
      return copyRecord(byUserId.get(String(userId)));
    },

    isBanned(userId) {
      return byUserId.has(String(userId));
    },

    list() {
      return [...byUserId.values()]
        .sort((a, b) => timestampKey(b.bannedAt).localeCompare(timestampKey(a.bannedAt)))
        .map(copyRecord);
    },
  };
}
