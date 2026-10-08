import { createHash } from "node:crypto";
import { isTraderOutputValid, isTraderSchemaValid, TraderProviderError } from "../providers/trader-ai-provider.js";

const LABELS = Object.freeze({ gemini: "Gemini", openai: "OpenAI", claude: "Claude" });
const MAX_CACHE_TTL_MS = 60_000;
const USAGE_FIELDS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "totalTokens"];
const ZERO_USAGE = Object.freeze(Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])));
const CREDENTIAL_FIELDS = /^(?:api[_-]?key|authorization|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key)$/i;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function environmentRate(key) {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? validRate(Number(value)) : null;
}

function readPricing() {
  return Object.fromEntries(Object.keys(LABELS).map((provider) => {
    const prefix = `BRAIN_${provider.toUpperCase()}`;
    return [provider, {
      inputPerMillion: environmentRate(`${prefix}_INPUT_USD_PER_MILLION`),
      outputPerMillion: environmentRate(`${prefix}_OUTPUT_USD_PER_MILLION`),
      cachedInputPerMillion: environmentRate(`${prefix}_CACHED_INPUT_USD_PER_MILLION`),
      cacheCreationInputPerMillion: environmentRate(`${prefix}_CACHE_CREATION_INPUT_USD_PER_MILLION`),
    }];
  }));
}

function normalizePricing(provider, rates) {
  const inputPerMillion = validRate(rates?.inputPerMillion);
  const outputPerMillion = validRate(rates?.outputPerMillion);
  if (inputPerMillion === null || outputPerMillion === null) return null;
  const cachedInputPerMillion = validRate(rates?.cachedInputPerMillion);
  // Our Claude breakpoint uses five minutes. OpenAI reports cache writes only
  // on newer models; both providers document a 1.25x ordinary-input write rate.
  const cacheCreationInputPerMillion = validRate(rates?.cacheCreationInputPerMillion)
    ?? (provider === "gemini" ? 0 : inputPerMillion * 1.25);
  if (!Number.isFinite(cacheCreationInputPerMillion)) return null;
  return { inputPerMillion, outputPerMillion, cachedInputPerMillion, cacheCreationInputPerMillion };
}

function normalizeUsage(value) {
  if (!value || USAGE_FIELDS.some((field) => !Number.isSafeInteger(value[field]) || value[field] < 0)) return null;
  const usage = Object.fromEntries(USAGE_FIELDS.map((field) => [field, value[field]]));
  if (usage.cachedInputTokens + usage.cacheCreationInputTokens > usage.inputTokens
    || usage.inputTokens + usage.outputTokens !== usage.totalTokens) return null;
  return usage;
}

function estimateCost(usage, rates) {
  if (!usage || !rates || (usage.cachedInputTokens > 0 && rates.cachedInputPerMillion === null)) return null;
  const ordinaryInput = usage.inputTokens - usage.cachedInputTokens - usage.cacheCreationInputTokens;
  const cost = (ordinaryInput * rates.inputPerMillion
    + usage.cachedInputTokens * (rates.cachedInputPerMillion ?? 0)
    + usage.cacheCreationInputTokens * rates.cacheCreationInputPerMillion
    + usage.outputTokens * rates.outputPerMillion) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

function checkSignal(signal) {
  if (signal?.aborted) throw new TraderProviderError();
}

async function cancellable(operation, signal) {
  checkSignal(signal);
  if (!signal) return operation();
  let onAbort;
  try {
    return await Promise.race([
      new Promise((_resolve, reject) => {
        onAbort = () => reject(new TraderProviderError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
      Promise.resolve().then(() => { checkSignal(signal); return operation(); }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function containsCredentials(value, secrets, depth = 0) {
  if (depth > 16) return true;
  if (typeof value === "string") {
    return secrets.some((secret) => value.includes(secret))
      || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{16,}|\bAIza[A-Za-z0-9_-]{30,}/.test(value);
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => CREDENTIAL_FIELDS.test(key) || containsCredentials(child, secrets, depth + 1));
}

/**
 * An exact-response cache is separate from each provider's prompt-prefix cache.
 * Cache rows contain validated results and usage, never request text or keys.
 */
export function createBrainModelGateway({ aiProvider, repository, now = () => new Date(), pricing } = {}) {
  const configuredPricing = pricing ?? readPricing();
  const secrets = ["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
    .map((name) => process.env[name]).filter((value) => typeof value === "string" && value.length > 0);

  function sanitizeStatus(status) {
    return {
      defaultProvider: Object.hasOwn(LABELS, status.defaultProvider) ? status.defaultProvider : "gemini",
      paidCallsEnabled: status.paidCallsEnabled === true,
      providers: Array.isArray(status.providers) ? status.providers.filter((item) => item && Object.hasOwn(LABELS, item.id))
        .map((item) => {
          const validModel = typeof item.model === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(item.model)
            && !containsCredentials(item.model, secrets);
          return { id: item.id, label: LABELS[item.id], model: validModel ? item.model : "", configured: validModel && item.configured === true };
        }) : [],
    };
  }

  function getStatus() {
    return sanitizeStatus(aiProvider?.getStatus?.() ?? { defaultProvider: "gemini", providers: [] });
  }

  async function getOwnerStatus(owner) {
    return aiProvider?.getOwnerStatus ? sanitizeStatus(await aiProvider.getOwnerStatus(owner)) : getStatus();
  }

  function getPricing(provider) {
    return typeof provider === "string" && Object.hasOwn(LABELS, provider)
      ? normalizePricing(provider, configuredPricing?.[provider]) : null;
  }

  return {
    getStatus,
    getOwnerStatus,
    getPricing,

    async generate(ownerId, { provider, system, prompt, schema, signal, maxOutputTokens = 8192, cacheTtlMs = MAX_CACHE_TTL_MS, cacheKey } = {}) {
      const startedAt = performance.now();
      if ((typeof ownerId !== "string" && typeof ownerId !== "number") || !String(ownerId).trim()
        || String(ownerId).length > 256 || (typeof ownerId === "number" && !Number.isFinite(ownerId))
        || typeof system !== "string" || !system.trim() || system.length > 32768
        || typeof prompt !== "string" || !prompt.trim() || prompt.length > 131072
        || !isTraderSchemaValid(schema)
        || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 8192
        || !Number.isFinite(cacheTtlMs)
        || (cacheKey !== undefined && (typeof cacheKey !== "string" || !cacheKey.length || cacheKey.length > 256))
        || (signal !== undefined && !(signal instanceof AbortSignal))) throw new TraderProviderError("TRADER_INPUT_INVALID");
      checkSignal(signal);
      const owner = String(ownerId);
      const status = await getOwnerStatus(owner);
      if (!status.paidCallsEnabled) throw new TraderProviderError("TRADER_PAID_AI_LOCKED");
      const selected = provider ?? status.defaultProvider;
      if (typeof selected !== "string" || !Object.hasOwn(LABELS, selected)) throw new TraderProviderError("TRADER_INPUT_INVALID");
      const definition = status.providers.find((item) => item.id === selected);
      if (!definition?.configured || (!aiProvider?.generateDetailed && !aiProvider?.generate)) {
        throw new TraderProviderError("TRADER_PROVIDER_NOT_CONFIGURED");
      }
      let serialized;
      try {
        serialized = JSON.stringify({ version: 1, owner, provider: selected, model: definition.model, system, prompt, schema, maxOutputTokens, namespace: cacheKey ?? "" });
      } catch { throw new TraderProviderError("TRADER_INPUT_INVALID"); }
      if (Buffer.byteLength(serialized) > 262144) throw new TraderProviderError("TRADER_INPUT_INVALID");
      const key = hash(serialized);
      const ttl = Math.max(0, Math.min(cacheTtlMs, MAX_CACHE_TTL_MS));
      let cacheEnabled = ttl > 0 && typeof repository?.getCache === "function" && typeof repository?.putCache === "function";
      const validData = (data) => isTraderOutputValid(data, schema) && !containsCredentials(data, secrets)
        && Buffer.byteLength(JSON.stringify(data)) <= 131072;
      if (cacheEnabled) {
        let entry;
        try { entry = await cancellable(() => repository.getCache(owner, key), signal); }
        catch { checkSignal(signal); cacheEnabled = false; }
        checkSignal(signal);
        const value = entry?.value;
        const currentMs = now().valueOf();
        const cachedAt = Date.parse(value?.cachedAt);
        if (value && value.provider === selected && value.model === definition.model
          && Number.isFinite(cachedAt) && cachedAt <= currentMs && cachedAt + ttl > currentMs
          && Date.parse(entry.expiresAt) > currentMs && validData(value.data)) {
          return {
            data: structuredClone(value.data), usage: { ...ZERO_USAGE }, sourceUsage: normalizeUsage(value.usage),
            latencyMs: Math.max(0, performance.now() - startedAt), provider: selected, model: definition.model,
            cache: { status: "hit", key }, estimatedCostUsd: 0,
          };
        }
      }

      // A stable, owner-scoped prefix key permits provider caching even when
      // short-lived exact-response caching is disabled. Dynamic data stays last.
      const prefixKey = hash(JSON.stringify({ owner, provider: selected, model: definition.model, system, schema, namespace: cacheKey ?? "" }));
      const request = { ownerId: owner, provider: selected, system, prompt, schema, signal, maxOutputTokens, cacheKey: prefixKey };
      let detailed;
      try {
        detailed = await cancellable(async () => {
          if (!getStatus().paidCallsEnabled) throw new TraderProviderError("TRADER_PAID_AI_LOCKED");
          if (typeof aiProvider.generateDetailed === "function") return aiProvider.generateDetailed(request);
          return { data: await aiProvider.generate(request), usage: null, provider: selected, model: definition.model };
        }, signal);
      } catch (error) {
        if (error instanceof TraderProviderError) throw error;
        throw new TraderProviderError(error?.code);
      }
      checkSignal(signal);
      if (!detailed || detailed.provider !== selected || detailed.model !== definition.model || !validData(detailed.data)) {
        throw new TraderProviderError();
      }
      const result = {
        data: structuredClone(detailed.data), usage: normalizeUsage(detailed.usage),
        latencyMs: Math.max(0, performance.now() - startedAt), provider: selected, model: definition.model,
        cache: { status: cacheEnabled ? "miss" : "disabled", key },
        estimatedCostUsd: estimateCost(normalizeUsage(detailed.usage), getPricing(selected)),
      };
      if (cacheEnabled) {
        const cachedAt = now();
        try {
          await cancellable(() => repository.putCache(owner, key, {
            value: { data: result.data, usage: result.usage, provider: selected, model: definition.model, cachedAt: cachedAt.toISOString() },
            expiresAt: new Date(cachedAt.valueOf() + ttl).toISOString(),
          }), signal);
        } catch { checkSignal(signal); result.cache.status = "disabled"; }
      }
      checkSignal(signal);
      result.latencyMs = Math.max(0, performance.now() - startedAt);
      return result;
    },
  };
}
