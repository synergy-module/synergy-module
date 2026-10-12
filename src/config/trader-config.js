const PROVIDERS = Object.freeze({
  gemini: { label: "Gemini", model: "gemini-3.8-flash", keyEnv: "GEMINI_API_KEY", modelEnv: "GEMINI_MODEL" },
  openai: { label: "OpenAI", model: "gpt-5.4-mini", keyEnv: "OPENAI_API_KEY", modelEnv: "OPENAI_MODEL" },
  claude: { label: "Claude", model: "claude-sonnet-5", keyEnv: "ANTHROPIC_API_KEY", modelEnv: "ANTHROPIC_MODEL" },
  grok: { label: "Grok", model: "grok-4.7", keyEnv: "XAI_API_KEY", modelEnv: "XAI_MODEL" },
});

function readValue(env, key) {
  return typeof env[key] === "string" ? env[key].trim() : "";
}

export function isTraderModelValid(provider, model) {
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) return false;
  if (provider === "gemini") return model.startsWith("gemini-");
  if (provider === "claude") return model.startsWith("claude-");
  if (provider === "grok") return model.startsWith("grok-");
  return provider === "openai" && /^(?:gpt-|o[1-9](?:-|$))/.test(model);
}

// This configuration contains credentials. Only the provider's getStatus() is public.
export function readTraderConfig(env = process.env) {
  const defaultProvider = readValue(env, "TRADER_AI_PROVIDER") || "gemini";
  if (!Object.hasOwn(PROVIDERS, defaultProvider)) {
    throw new Error("TRADER_AI_PROVIDER must be gemini, openai, claude, or grok");
  }

  const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([id, definition]) => {
    const model = readValue(env, definition.modelEnv) || definition.model;
    if (!isTraderModelValid(id, model)) {
      throw new Error(`${definition.modelEnv} must be a valid model ID for the selected provider`);
    }
    const apiKey = readValue(env, definition.keyEnv);
    if (apiKey.length > 8192 || /\s/.test(apiKey)) {
      throw new Error(`${definition.keyEnv} must contain a valid API key`);
    }
    return [id, { id, label: definition.label, model, apiKey }];
  }));

  return { defaultProvider, paidCallsEnabled: readValue(env, "TRADER_PAID_AI_ENABLED") === "true", providers };
}
