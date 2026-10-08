function copyRecord(record) {
  return record == null ? null : structuredClone(record);
}

function timestampKey(value) {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function recentTimestamp(record) {
  return [record.lastSeenAt, record.updatedAt, record.firstSeenAt, record.rolesSyncedAt]
    .map(timestampKey)
    .sort()
    .at(-1) ?? "";
}

export function createInMemoryUserRepository({ now = () => new Date().toISOString() } = {}) {
  const byId = new Map();

  return {
    upsert(input) {
      const id = String(input.id);
      const existing = byId.get(id);
      const timestamp = now();
      const record = {
        ...(existing ?? {}),
        ...structuredClone(input),
        id,
        roles: [...(input.roles ?? [])],
        capabilities: [...(input.capabilities ?? [])],
        firstSeenAt: existing?.firstSeenAt ?? input.firstSeenAt ?? timestamp,
        lastSeenAt: timestamp,
      };
      byId.set(id, record);
      return copyRecord(record);
    },

    findById(id) {
      return copyRecord(byId.get(String(id)));
    },

    list() {
      return [...byId.values()]
        .sort((a, b) => recentTimestamp(b).localeCompare(recentTimestamp(a)))
        .map(copyRecord);
    },
  };
}
