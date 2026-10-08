import { createJournalEntry } from "./journal-entry.js";

export function createJournalService(repository, clock = () => new Date(), idFactory = () => String(Date.now())) {
  return {
    list() {
      return repository.list();
    },

    find(id) {
      return repository.find(id);
    },

    create(input) {
      const now = clock();
      const entry = createJournalEntry(input, {
        id: idFactory(),
        createdAt: now.toISOString(),
      });
      return repository.create(entry);
    },
  };
}
