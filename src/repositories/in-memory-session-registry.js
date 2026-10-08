export function createInMemorySessionRegistry() {
  const byUser = new Map();
  const revokedSessionIds = new Set();

  return {
    register(userId, sessionId) {
      const key = String(userId);
      const normalizedSessionId = String(sessionId);
      const ids = byUser.get(key) ?? new Set();
      ids.add(normalizedSessionId);
      byUser.set(key, ids);
      revokedSessionIds.delete(normalizedSessionId);
    },

    unregister(userId, sessionId) {
      const key = String(userId);
      const ids = byUser.get(key);
      const normalizedSessionId = String(sessionId);
      ids?.delete(normalizedSessionId);
      if (ids?.size === 0) byUser.delete(key);
      revokedSessionIds.delete(normalizedSessionId);
    },

    markRevoked(sessionId) {
      revokedSessionIds.add(String(sessionId));
    },

    isRevoked(sessionId) {
      return revokedSessionIds.has(String(sessionId));
    },

    listSessionIds(userId) {
      return [...(byUser.get(String(userId)) ?? [])];
    },

    activeCount(userId) {
      return byUser.get(String(userId))?.size ?? 0;
    },

    clearUser(userId) {
      const key = String(userId);
      const ids = [...(byUser.get(key) ?? [])];
      byUser.delete(key);
      ids.forEach((sessionId) => revokedSessionIds.delete(sessionId));
      return ids;
    },
  };
}
