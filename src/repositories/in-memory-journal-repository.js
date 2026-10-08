export function createInMemoryJournalRepository() {
  const byOwner = new Map();
  return {
    async list(ownerId) {
      return [...(byOwner.get(String(ownerId)) ?? [])];
    },
    async find(ownerId, id) {
      return (byOwner.get(String(ownerId)) ?? []).find((entry) => entry.id === String(id));
    },
    async create(ownerId, entry) {
      const key = String(ownerId);
      byOwner.set(key, [entry, ...(byOwner.get(key) ?? [])]);
      return entry;
    },
  };
}
