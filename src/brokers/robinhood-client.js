import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROBINHOOD_MCP_URL, brokerError } from "./robinhood-catalog.js";

// Verified from Robinhood's public OAuth metadata. Never accept destinations from a model or request body.
const AUTHORIZE = "https://robinhood.com/oauth";
const REGISTER = "https://agent.robinhood.com/oauth/trading/register";
const TOKEN = "https://api.robinhood.com/oauth2/token/";
const OAUTH_SCOPE = "internal";
export function readRobinhoodConfig(env = process.env) {
  const key = env.ROBINHOOD_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  const clientId = env.ROBINHOOD_CLIENT_ID?.trim() ?? "";
  const validClientId = !clientId || /^[\x21-\x7e]{1,1024}$/.test(clientId);
  let redirectUri = env.ROBINHOOD_REDIRECT_URI?.trim();
  if (!redirectUri && env.DISCORD_REDIRECT_URI) {
    try { redirectUri = new URL("/auth/robinhood/callback", env.DISCORD_REDIRECT_URI).href; } catch {}
  }
  let validRedirect = false;
  try {
    const url = new URL(redirectUri);
    validRedirect = !url.username && !url.password && !url.hash && !url.search && url.pathname === "/auth/robinhood/callback"
      && (url.protocol === "https:" || (env.NODE_ENV !== "production" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)));
  } catch {}
  return { encryptionKey: key, redirectUri, clientId, configured: /^[a-fA-F0-9]{64}$/.test(key) && validRedirect && validClientId,
    liveEnabled: env.ROBINHOOD_LIVE_TRADING_ENABLED === "true",
    missing: [...(!/^[a-fA-F0-9]{64}$/.test(key) ? ["ROBINHOOD_TOKEN_ENCRYPTION_KEY"] : []), ...(!validRedirect ? ["ROBINHOOD_REDIRECT_URI"] : []), ...(!validClientId ? ["ROBINHOOD_CLIENT_ID"] : [])] };
}
export function createBrokerCipher(keyHex) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw brokerError("ROBINHOOD_CONFIG", "Robinhood token encryption is not configured.", 503);
  return {
    seal(owner, value) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(owner));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") };
    },
    open(owner, sealed) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
        decipher.setAAD(Buffer.from(owner)); decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8"));
      } catch { throw brokerError("ROBINHOOD_RECONNECT", "Reconnect Robinhood to restore account access.", 401); }
    },
  };
}
export function createRobinhoodClient({ fetchImpl = fetch, now = () => Date.now(), transportFactory } = {}) {
  async function jsonRequest(url, body) {
    const isForm = body instanceof URLSearchParams;
    const response = await fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json", Accept: "application/json" },
      body: isForm ? body.toString() : JSON.stringify(body) });
    if (!response.ok) throw brokerError("ROBINHOOD_AUTH_FAILED", "Robinhood could not complete authorization. Reconnect and try again.", 502);
    const text = await response.text();
    if (text.length > 64000) throw brokerError("ROBINHOOD_RESPONSE", "Robinhood returned an oversized response.", 502);
    try { return JSON.parse(text); } catch { throw brokerError("ROBINHOOD_RESPONSE", "Robinhood returned an unreadable response.", 502); }
  }
  function normalizeTokens(value, previous) {
    if (typeof value.access_token !== "string" || !value.access_token || value.token_type?.toLowerCase() !== "bearer"
      || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0) throw brokerError("ROBINHOOD_AUTH_FAILED", "Robinhood did not return usable authorization.", 502);
    return { accessToken: value.access_token, refreshToken: value.refresh_token ?? previous?.refreshToken,
      expiresAt: now() + Number(value.expires_in) * 1000 };
  }
  return {
    async begin(redirectUri, registeredClientId) {
      // A provider-approved public client keeps its registered identity and callback allowlist.
      // A successful dynamic registration response alone does not establish callback approval.
      let clientId = registeredClientId;
      if (!clientId) {
        const registration = await jsonRequest(REGISTER, { client_name: "Synergy Module Brain", redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: OAUTH_SCOPE });
        clientId = registration.client_id;
      }
      if (typeof clientId !== "string" || !clientId) throw brokerError("ROBINHOOD_AUTH_FAILED", "Robinhood client registration was unsuccessful.", 502);
      const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
      const pending = { state, verifier, clientId, redirectUri, createdAt: now() };
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({ response_type: "code", client_id: pending.clientId, redirect_uri: redirectUri,
        scope: OAUTH_SCOPE, resource: ROBINHOOD_MCP_URL, state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
      return { pending, authorizationUrl: url.href };
    },
    async complete(pending, code) {
      const tokens = normalizeTokens(await jsonRequest(TOKEN, new URLSearchParams({ grant_type: "authorization_code", code,
        client_id: pending.clientId, redirect_uri: pending.redirectUri, code_verifier: pending.verifier, resource: ROBINHOOD_MCP_URL })));
      return { ...tokens, clientId: pending.clientId };
    },
    async refresh(credentials) {
      if (!credentials.refreshToken) throw brokerError("ROBINHOOD_RECONNECT", "Reconnect Robinhood to renew account access.", 401);
      return { ...credentials, ...normalizeTokens(await jsonRequest(TOKEN, new URLSearchParams({ grant_type: "refresh_token",
        refresh_token: credentials.refreshToken, client_id: credentials.clientId, resource: ROBINHOOD_MCP_URL })), credentials) };
    },
    async withSession(credentials, work, { signal } = {}) {
      const deadline = AbortSignal.timeout(20000);
      const boundedFetch = (url, options = {}) => {
        if (new URL(url).href !== ROBINHOOD_MCP_URL) throw brokerError("ROBINHOOD_DESTINATION", "Unexpected broker destination.", 502);
        return fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.any([deadline, ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]) });
      };
      const transport = transportFactory?.(credentials) ?? new StreamableHTTPClientTransport(new URL(ROBINHOOD_MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${credentials.accessToken}` } }, fetch: boundedFetch,
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
      const client = new Client({ name: "synergy-module-brain", version: "0.1.2" }, { capabilities: {} });
      try {
        await client.connect(transport, { timeout: 15000 });
        return await work({
          async listTools() {
            const tools = []; let cursor;
            for (let page = 0; page < 5; page++) {
              const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000, signal });
              tools.push(...result.tools);
              if (tools.length > 128 || Buffer.byteLength(JSON.stringify(tools)) > 500000) throw brokerError("ROBINHOOD_CATALOG", "Robinhood tool discovery exceeded its limit.", 502);
              if (!result.nextCursor) return tools;
              cursor = result.nextCursor;
            }
            throw brokerError("ROBINHOOD_CATALOG", "Robinhood tool discovery was incomplete.", 502);
          },
          async call(name, args) {
            const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000, signal });
            if (Buffer.byteLength(JSON.stringify(result)) > 64000) throw brokerError("ROBINHOOD_RESPONSE", "Narrow the request; Robinhood returned too much data.", 502);
            if (result.isError) throw brokerError("ROBINHOOD_TOOL_REJECTED", "Robinhood could not complete this request. Review the parameters and account permissions.", 422);
            return { structuredContent: result.structuredContent ?? null, content: (result.content ?? []).filter((item) => item.type === "text").map((item) => ({ type: "text", text: item.text })) };
          },
        });
      } catch (error) {
        if (error?.code?.startsWith?.("ROBINHOOD_")) throw error;
        throw brokerError("ROBINHOOD_UNAVAILABLE", "Robinhood did not return a confirmed result. Check your connection and broker activity before retrying.", 502);
      } finally { await client.close().catch(() => {}); }
    },
  };
}
