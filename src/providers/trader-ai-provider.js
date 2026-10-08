import { isTraderModelValid, readTraderConfig } from "../config/trader-config.js";
import { createHash } from "node:crypto";

const PROVIDER_LABELS = Object.freeze({ gemini: "Gemini", openai: "OpenAI", claude: "Claude" });
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 131_072;
const ERROR_DETAILS = Object.freeze({
  TRADER_PAID_AI_LOCKED: [423, "Paid AI calls are locked. Continue with the offline demo and evaluations until setup is confirmed."],
  TRADER_PROVIDER_NOT_CONFIGURED: [503, "This AI provider is not configured. Ask an administrator to add its API key."],
  TRADER_PROVIDER_ERROR: [502, "The AI provider could not complete this analysis. Please try again."],
  TRADER_PROVIDER_TIMEOUT: [504, "The AI provider took too long to respond. Please try again."],
  TRADER_INPUT_INVALID: [422, "The AI analysis request is invalid."],
});
const SCHEMA_KEYS = new Set(["type", "title", "description", "enum", "properties", "required", "additionalProperties", "items", "anyOf"]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

export class TraderProviderError extends Error {
  constructor(code = "TRADER_PROVIDER_ERROR") {
    const safeCode = Object.hasOwn(ERROR_DETAILS, code) ? code : "TRADER_PROVIDER_ERROR";
    const [status, message] = ERROR_DETAILS[safeCode];
    super(message);
    this.name = "TraderProviderError";
    this.code = safeCode;
    this.status = status;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Use the common strict schema subset supported by all three APIs. Business
// constraints (price bounds, text lengths, etc.) belong in the trading service.
function isSchemaValid(schema, depth = 0) {
  if (depth > 12 || !isObject(schema) || Object.keys(schema).some((key) => !SCHEMA_KEYS.has(key))) return false;
  for (const key of ["title", "description"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") return false;
  }
  if (schema.anyOf !== undefined) {
    return !schema.type && Array.isArray(schema.anyOf) && schema.anyOf.length > 0
      && schema.anyOf.every((branch) => isSchemaValid(branch, depth + 1));
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.some((type) => !SCHEMA_TYPES.has(type))) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length
    || schema.enum.some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value)))) return false;
  if (types.includes("object")) {
    if (!isObject(schema.properties) || schema.additionalProperties !== false || !Array.isArray(schema.required)) return false;
    const keys = Object.keys(schema.properties);
    if (schema.required.length !== keys.length || new Set(schema.required).size !== keys.length
      || !schema.required.every((key) => Object.hasOwn(schema.properties, key))) return false;
    if (!Object.values(schema.properties).every((child) => isSchemaValid(child, depth + 1))) return false;
  }
  return !types.includes("array") || isSchemaValid(schema.items, depth + 1);
}

function matchesSchema(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((branch) => matchesSchema(value, branch));
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matchesType = types.some((type) => {
    if (type === "null") return value === null;
    if (type === "object") return isObject(value);
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  });
  if (!matchesType || (schema.enum && !schema.enum.includes(value))) return false;
  if (isObject(value)) {
    if (Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) return false;
    return schema.required.every((key) => Object.hasOwn(value, key) && matchesSchema(value[key], schema.properties[key]));
  }
  if (Array.isArray(value)) return value.every((item) => matchesSchema(item, schema.items));
  return true;
}

export function isTraderOutputValid(value, schema) {
  return isObject(value) && schema?.type === "object" && isSchemaValid(schema) && matchesSchema(value, schema);
}

export function isTraderSchemaValid(schema) {
  return schema?.type === "object" && isSchemaValid(schema);
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function optionalTokenCount(value) {
  // Omitted cache counters represent no cache activity; explicit invalid/null
  // counters remain unavailable, rather than being converted into zero usage.
  return value === undefined ? 0 : tokenCount(value);
}

function extractUsage(provider, body) {
  let inputTokens;
  let outputTokens;
  let totalTokens;
  let cachedInputTokens;
  let cacheCreationInputTokens;
  if (provider === "gemini") {
    const usage = body?.usageMetadata;
    if (!usage) return null;
    inputTokens = tokenCount(usage.promptTokenCount);
    totalTokens = tokenCount(usage.totalTokenCount);
    // Gemini's total includes thoughts, which are billed as generated tokens.
    outputTokens = inputTokens !== null && totalTokens !== null ? tokenCount(totalTokens - inputTokens) : null;
    cachedInputTokens = optionalTokenCount(usage.cachedContentTokenCount);
    cacheCreationInputTokens = 0; // This adapter never creates explicit Gemini cache resources.
    if ([usage.candidatesTokenCount, usage.thoughtsTokenCount].some((value) => value !== undefined
      && (tokenCount(value) === null || outputTokens === null || value > outputTokens))) return null;
  } else if (provider === "openai") {
    const usage = body?.usage;
    if (!usage) return null;
    inputTokens = tokenCount(usage.input_tokens);
    outputTokens = tokenCount(usage.output_tokens);
    totalTokens = tokenCount(usage.total_tokens);
    cachedInputTokens = optionalTokenCount(usage.input_tokens_details?.cached_tokens);
    cacheCreationInputTokens = optionalTokenCount(usage.input_tokens_details?.cache_write_tokens);
  } else {
    const usage = body?.usage;
    if (!usage) return null;
    const ordinaryInput = tokenCount(usage.input_tokens);
    cachedInputTokens = optionalTokenCount(usage.cache_read_input_tokens);
    cacheCreationInputTokens = optionalTokenCount(usage.cache_creation_input_tokens);
    outputTokens = tokenCount(usage.output_tokens);
    inputTokens = [ordinaryInput, cachedInputTokens, cacheCreationInputTokens].includes(null)
      ? null : tokenCount(ordinaryInput + cachedInputTokens + cacheCreationInputTokens);
    totalTokens = inputTokens === null || outputTokens === null ? null : tokenCount(inputTokens + outputTokens);
  }
  const counts = { inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens, totalTokens };
  if (Object.values(counts).includes(null) || cachedInputTokens + cacheCreationInputTokens > inputTokens
    || totalTokens !== inputTokens + outputTokens) return null;
  return counts;
}

async function readResponseJson(response, signal) {
  const announcedLength = Number(response.headers?.get("content-length"));
  if (announcedLength > MAX_BODY_BYTES) throw new TraderProviderError();
  if (!response.body?.getReader) throw new TraderProviderError();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new TraderProviderError();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new TraderProviderError();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } finally {
    // Do not await cancellation: a faulty upstream stream must not delay timeout.
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

function makeRequest(provider, { model, apiKey }, { system, prompt, schema, maxOutputTokens, cacheKey }) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (provider === "gemini") {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { ...headers, "x-goog-api-key": apiKey },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
        },
      },
    };
  }
  if (provider === "openai") {
    return {
      url: "https://api.openai.com/v1/responses",
      headers: { ...headers, Authorization: `Bearer ${apiKey}` },
      body: {
        model,
        instructions: system,
        input: [{ role: "user", content: prompt }],
        store: false,
        max_output_tokens: maxOutputTokens,
        // Hash routing hints so a caller-supplied identifier never leaves the server.
        ...(cacheKey ? { prompt_cache_key: createHash("sha256").update(cacheKey).digest("hex") } : {}),
        text: { format: { type: "json_schema", name: "trader_analysis", strict: true, schema } },
      },
    };
  }
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { ...headers, "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: {
      model,
      system: cacheKey ? [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "5m" } }] : system,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxOutputTokens,
      output_config: { format: { type: "json_schema", schema } },
    },
  };
}

function extractOutput(provider, body) {
  if (provider === "gemini") {
    const candidate = body?.candidates?.[0];
    if (body?.promptFeedback?.blockReason || candidate?.finishReason !== "STOP"
      || !Array.isArray(candidate?.content?.parts)) throw new TraderProviderError();
    return candidate.content.parts.filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text).join("");
  }
  if (provider === "openai") {
    if (body?.status !== "completed" || body.error || body.incomplete_details || !Array.isArray(body.output)) {
      throw new TraderProviderError();
    }
    const messages = body.output.filter((item) => item.type === "message");
    if (!messages.length || messages.some((item) => item.status !== "completed" || !Array.isArray(item.content))) {
      throw new TraderProviderError();
    }
    const blocks = messages.flatMap((item) => item.content);
    if (blocks.some((part) => part.type === "refusal")) throw new TraderProviderError();
    return blocks.filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text).join("");
  }
  if (body?.stop_reason !== "end_turn" || !Array.isArray(body?.content)) throw new TraderProviderError();
  return body.content.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("");
}

export function createTraderAIProvider({
  config = readTraderConfig(), fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  // Credentials alone never authorize paid work. Activation is server-owned
  // and captured at startup, independent of request fields or status objects.
  const paidCallsEnabled = config.paidCallsEnabled === true;
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const knownSecrets = Object.values(config.providers || {}).map((item) => item.apiKey)
    .filter((key) => typeof key === "string" && key.length > 0);

  const api = {
    getStatus() {
      return {
        defaultProvider: Object.hasOwn(PROVIDER_LABELS, config.defaultProvider) ? config.defaultProvider : "gemini",
        paidCallsEnabled,
        providers: Object.entries(PROVIDER_LABELS).map(([id, label]) => {
          const definition = config.providers?.[id];
          const validModel = isTraderModelValid(id, definition?.model)
            && !knownSecrets.some((key) => definition.model.includes(key));
          return { id, label, model: validModel ? definition.model : "", configured: Boolean(validModel && definition?.apiKey) };
        }),
      };
    },

    async generateDetailed({ provider = config.defaultProvider, system, prompt, schema, signal, maxOutputTokens = 8192, cacheKey } = {}) {
      const startedAt = performance.now();
      if (!paidCallsEnabled) throw new TraderProviderError("TRADER_PAID_AI_LOCKED");
      if (typeof provider !== "string" || !Object.hasOwn(PROVIDER_LABELS, provider)) {
        throw new TraderProviderError("TRADER_INPUT_INVALID");
      }
      const definition = config.providers?.[provider];
      if (!definition?.apiKey) throw new TraderProviderError("TRADER_PROVIDER_NOT_CONFIGURED");
      if (!isTraderModelValid(provider, definition.model) || typeof definition.apiKey !== "string"
        || /\s/.test(definition.apiKey) || definition.apiKey.length > 8192
        || knownSecrets.some((key) => definition.model.includes(key))) throw new TraderProviderError();
      if (typeof system !== "string" || !system.trim() || system.length > 32_768
        || typeof prompt !== "string" || !prompt.trim() || prompt.length > 131_072
        || schema?.type !== "object" || !isSchemaValid(schema)
        || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 8192
        || (cacheKey !== undefined && (typeof cacheKey !== "string" || !cacheKey.length || cacheKey.length > 256 || /[\u0000-\u001f]/.test(cacheKey)))
        || (signal !== undefined && !(signal instanceof AbortSignal))) {
        throw new TraderProviderError("TRADER_INPUT_INVALID");
      }

      const controller = new AbortController();
      let timeout;
      let onAbort;
      let timedOut = false;
      try {
        const request = makeRequest(provider, definition, { system, prompt, schema, maxOutputTokens, cacheKey });
        const requestBody = JSON.stringify(request.body);
        if (Buffer.byteLength(requestBody) > 262_144) throw new TraderProviderError("TRADER_INPUT_INVALID");
        const interrupted = new Promise((_resolve, reject) => {
          onAbort = () => {
            controller.abort();
            reject(new TraderProviderError(timedOut ? "TRADER_PROVIDER_TIMEOUT" : "TRADER_PROVIDER_ERROR"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          timeout = setTimeout(() => { timedOut = true; onAbort(); }, boundedTimeout);
        });
        const work = async () => {
          if (signal?.aborted) { onAbort(); return; }
          const response = await fetchImpl(request.url, {
            method: "POST", headers: request.headers, body: requestBody, redirect: "error", signal: controller.signal,
          });
          if (controller.signal.aborted || !response?.ok) {
            response?.body?.cancel().catch(() => {});
            throw new TraderProviderError();
          }
          const body = await readResponseJson(response, controller.signal);
          const output = extractOutput(provider, body);
          if (!output || Buffer.byteLength(output) > MAX_OUTPUT_BYTES
            || knownSecrets.some((key) => output.includes(key))) throw new TraderProviderError();
          const parsed = JSON.parse(output);
          if (!isObject(parsed) || !matchesSchema(parsed, schema)
            || knownSecrets.some((key) => JSON.stringify(parsed).includes(key))) throw new TraderProviderError();
          return { data: parsed, usage: extractUsage(provider, body), latencyMs: Math.max(0, performance.now() - startedAt), provider, model: definition.model };
        };
        return await Promise.race([interrupted, work()]);
      } catch (error) {
        if (timedOut) throw new TraderProviderError("TRADER_PROVIDER_TIMEOUT");
        if (error instanceof TraderProviderError) throw error;
        throw new TraderProviderError();
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        controller.abort();
      }
    },
    async generate(request) {
      return (await api.generateDetailed(request)).data;
    },
  };
  return api;
}
