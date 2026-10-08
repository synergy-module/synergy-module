const API_BASE = "https://discord.com/api/v10";
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

export class DiscordProviderError extends Error {
  constructor(code) {
    super("Discord authentication is temporarily unavailable");
    this.name = "DiscordProviderError";
    this.code = code;
  }
}

function requestTimeoutMs(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(value, MAX_REQUEST_TIMEOUT_MS);
}

function avatarUrlFor({ id, avatar }) {
  return typeof avatar === "string" && avatar
    ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
    : null;
}

export function createDiscordOAuthProvider({
  clientId,
  clientSecret,
  redirectUri,
  guildId,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs: configuredTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  now = () => new Date(),
} = {}) {
  const timeoutMs = requestTimeoutMs(configuredTimeoutMs);

  async function requestJson(url, options, { parseJson = true } = {}) {
    const abortController = new AbortController();
    let timeout;

    try {
      timeout = setTimeoutImpl(() => abortController.abort(), timeoutMs);
      const response = await fetchImpl(url, { ...options, signal: abortController.signal });
      if (!response?.ok) throw new DiscordProviderError("DISCORD_HTTP_ERROR");
      return parseJson ? await response.json() : undefined;
    } catch (error) {
      if (error instanceof DiscordProviderError) throw error;
      if (abortController.signal.aborted) throw new DiscordProviderError("DISCORD_TIMEOUT");
      throw new DiscordProviderError("DISCORD_REQUEST_FAILED");
    } finally {
      if (timeout !== undefined) clearTimeoutImpl(timeout);
    }
  }

  async function requestToken(parameters) {
    const payload = await requestJson(`${API_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        ...parameters,
      }),
    });

    if (
      typeof payload?.access_token !== "string"
      || typeof payload?.refresh_token !== "string"
      || !Number.isFinite(payload?.expires_in)
    ) {
      throw new DiscordProviderError("DISCORD_INVALID_RESPONSE");
    }

    const issuedAt = now();
    const issuedAtMs = issuedAt instanceof Date ? issuedAt.getTime() : new Date(issuedAt).getTime();
    if (!Number.isFinite(issuedAtMs)) throw new DiscordProviderError("DISCORD_INVALID_RESPONSE");

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: new Date(issuedAtMs + (payload.expires_in * 1_000)).toISOString(),
    };
  }

  return {
    buildAuthorizationUrl({ state }) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "identify guilds.members.read",
        state,
      }).toString();
      return url.toString();
    },

    exchangeCode({ code }) {
      return requestToken({ grant_type: "authorization_code", code });
    },

    async getCurrentUser({ accessToken }) {
      const payload = await requestJson(`${API_BASE}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (typeof payload?.id !== "string" || typeof payload?.username !== "string") {
        throw new DiscordProviderError("DISCORD_INVALID_RESPONSE");
      }
      return {
        id: payload.id,
        username: payload.username,
        displayName: typeof payload.global_name === "string" && payload.global_name
          ? payload.global_name
          : payload.username,
        avatarUrl: avatarUrlFor(payload),
      };
    },

    async getCurrentGuildMember({ accessToken }) {
      const payload = await requestJson(`${API_BASE}/users/@me/guilds/${encodeURIComponent(guildId)}/member`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!Array.isArray(payload?.roles) || !payload.roles.every((role) => typeof role === "string")) {
        throw new DiscordProviderError("DISCORD_INVALID_RESPONSE");
      }
      return { roles: payload.roles };
    },

    refreshAccessToken({ refreshToken }) {
      return requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
    },

    async revokeToken({ token }) {
      await requestJson(
        `${API_BASE}/oauth2/token/revoke`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            token,
          }),
        },
        { parseJson: false },
      );
    },
  };
}
