import { createTraderAIProvider, TraderProviderError } from "./trader-ai-provider.js";

/** Resolve account credentials at each request, without a process-global owner. */
export function createWorkspaceAIProvider({ settingsService, fallbackProvider = createTraderAIProvider(), fetchImpl } = {}) {
  const api = {
    getStatus: () => fallbackProvider.getStatus(),
    async getOwnerStatus(ownerId) {
      const state = await settingsService.getState(String(ownerId));
      return { defaultProvider: state.preferences.provider, paidCallsEnabled: state.paidCallsEnabled,
        providers: state.providers.map(({ id, label, model, configured }) => ({ id, label, model, configured })) };
    },
    async generateDetailed(request = {}) {
      const { ownerId, ...input } = request;
      const status = fallbackProvider.getStatus();
      // The server's paid-call switch applies equally to supplied and saved keys.
      if (status.paidCallsEnabled !== true) throw new TraderProviderError("TRADER_PAID_AI_LOCKED");
      if (ownerId === undefined) {
        if (fallbackProvider.generateDetailed) return fallbackProvider.generateDetailed(input);
        return { data: await fallbackProvider.generate(input), usage: null, provider: input.provider, model: status.providers.find((item) => item.id === input.provider)?.model };
      }
      const owner = String(ownerId);
      const ownerStatus = await api.getOwnerStatus(owner);
      const provider = input.provider ?? ownerStatus.defaultProvider;
      const definition = ownerStatus.providers.find((item) => item.id === provider);
      if (!definition?.configured) throw new TraderProviderError("TRADER_PROVIDER_NOT_CONFIGURED");
      let apiKey;
      try { apiKey = await settingsService.getProviderCredential(owner, provider); }
      catch { throw new TraderProviderError("TRADER_PROVIDER_NOT_CONFIGURED"); }
      if (!apiKey) {
        if (fallbackProvider.generateDetailed) return fallbackProvider.generateDetailed({ ...input, provider });
        return { data: await fallbackProvider.generate({ ...input, provider }), usage: null, provider, model: definition.model };
      }
      const accountProvider = createTraderAIProvider({
        config: { defaultProvider: provider, paidCallsEnabled: status.paidCallsEnabled, providers: { [provider]: { apiKey, model: definition.model } } },
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      return accountProvider.generateDetailed({ ...input, provider });
    },
    async generate(request) { return (await api.generateDetailed(request)).data; },
  };
  return api;
}
