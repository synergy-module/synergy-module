export class HttpJournalRepository {
  constructor(fetchImpl, csrfToken) {
    this.fetchImpl = fetchImpl;
    this.csrfToken = csrfToken;
  }

  async request(path, options = {}) {
    const response = await this.fetchImpl(path, {
      credentials: "same-origin",
      ...options,
      headers: { Accept: "application/json", ...(options.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Journal request failed (${response.status})`);
    return response.json();
  }

  async list() {
    return (await this.request("/api/journal")).entries;
  }

  async find(id) {
    try {
      return (await this.request(`/api/journal/${encodeURIComponent(id)}`)).entry;
    } catch (error) {
      if (/\(404\)/.test(error.message)) return undefined;
      throw error;
    }
  }

  async create(entry) {
    return (await this.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": this.csrfToken },
      body: JSON.stringify(entry),
    })).entry;
  }
}
