import test from "node:test";
import assert from "node:assert/strict";
import { DiscordProviderError, createDiscordOAuthProvider } from "../../src/providers/discord-oauth-provider.js";

test("authorization URL requests only identity and member scopes", () => {
  const provider = createDiscordOAuthProvider({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    guildId: "guild",
    fetchImpl: async () => { throw new Error("unexpected fetch"); },
  });

  const url = new URL(provider.buildAuthorizationUrl({ state: "state-value" }));

  assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "identify guilds.members.read");
  assert.equal(url.searchParams.get("state"), "state-value");
});

test("token and profile requests keep credentials in server requests", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth2/token")) {
      return Response.json({
        access_token: "access",
        token_type: "Bearer",
        expires_in: 604800,
        refresh_token: "refresh",
        scope: "identify guilds.members.read",
      });
    }
    if (String(url).endsWith("/users/@me")) {
      return Response.json({
        id: "42",
        username: "omen",
        discriminator: "0",
        global_name: "Omen",
        avatar: "avatar-hash",
        bot: false,
        system: false,
        mfa_enabled: true,
        banner: null,
        accent_color: null,
        locale: "en-US",
        verified: true,
        email: "omen@example.test",
        flags: 0,
        premium_type: 0,
        public_flags: 0,
        avatar_decoration_data: null,
        collectibles: null,
        primary_guild: null,
      });
    }
    return Response.json({
      user: { id: "42", username: "omen", discriminator: "0", avatar: "avatar-hash" },
      nick: null,
      avatar: null,
      banner: null,
      roles: ["role-os", "role-indicators"],
      joined_at: "2025-01-01T00:00:00.000000+00:00",
      premium_since: null,
      deaf: false,
      mute: false,
      flags: 0,
      pending: false,
      permissions: "0",
      communication_disabled_until: null,
      avatar_decoration_data: null,
    });
  };
  const provider = createDiscordOAuthProvider({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    guildId: "guild",
    fetchImpl,
  });

  const token = await provider.exchangeCode({ code: "code" });
  const identity = await provider.getCurrentUser({ accessToken: token.accessToken });
  const member = await provider.getCurrentGuildMember({ accessToken: token.accessToken });

  assert.equal(identity.id, "42");
  assert.deepEqual(member.roles, ["role-os", "role-indicators"]);
  assert.match(calls[0].options.body.toString(), /grant_type=authorization_code/);
  assert.doesNotMatch(calls[0].url, /secret|code/);
});

test("token revocation accepts Discord's empty successful response", async () => {
  const provider = createDiscordOAuthProvider({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    guildId: "guild",
    fetchImpl: async () => new Response(null, { status: 204 }),
  });

  await provider.revokeToken({ token: "access" });
});

test("provider converts Discord HTTP failures to a safe typed error", async () => {
  const provider = createDiscordOAuthProvider({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    guildId: "guild",
    fetchImpl: async () => Response.json({ message: "private Discord detail" }, { status: 503 }),
  });

  await assert.rejects(provider.exchangeCode({ code: "code" }), (error) => {
    assert.ok(error instanceof DiscordProviderError);
    assert.equal(error.code, "DISCORD_HTTP_ERROR");
    assert.doesNotMatch(error.message, /private|code/i);
    return true;
  });
});

test("provider converts network and malformed-response failures to safe typed errors", async () => {
  const sharedConfig = {
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    guildId: "guild",
  };
  const cases = [
    {
      name: "network failure",
      fetchImpl: async () => { throw new Error("token=private-access"); },
      code: "DISCORD_REQUEST_FAILED",
    },
    {
      name: "malformed JSON",
      fetchImpl: async () => new Response("not-json", { status: 200 }),
      code: "DISCORD_REQUEST_FAILED",
    },
    {
      name: "malformed token payload",
      fetchImpl: async () => Response.json({ access_token: "access" }),
      code: "DISCORD_INVALID_RESPONSE",
    },
  ];

  for (const fixture of cases) {
    const provider = createDiscordOAuthProvider({ ...sharedConfig, fetchImpl: fixture.fetchImpl });
    await assert.rejects(provider.exchangeCode({ code: "code" }), (error) => {
      assert.ok(error instanceof DiscordProviderError, fixture.name);
      assert.equal(error.code, fixture.code, fixture.name);
      assert.doesNotMatch(error.message, /private-access|code/i, fixture.name);
      return true;
    });
  }
});

test("provider aborts a bounded timeout with a safe typed error", async () => {
  let triggerTimeout;
  let abortSignal;
  const clearedTimers = [];
  const provider = createDiscordOAuthProvider({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    guildId: "guild",
    requestTimeoutMs: 250,
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 250);
      triggerTimeout = callback;
      return "provider-timeout";
    },
    clearTimeoutImpl(timer) {
      clearedTimers.push(timer);
    },
    fetchImpl: async (_url, options) => {
      abortSignal = options.signal;
      return new Promise((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => {
          reject(new DOMException("private token detail", "AbortError"));
        }, { once: true });
      });
    },
  });

  const request = provider.exchangeCode({ code: "code" });
  triggerTimeout();

  await assert.rejects(request, (error) => {
    assert.ok(error instanceof DiscordProviderError);
    assert.equal(error.code, "DISCORD_TIMEOUT");
    assert.doesNotMatch(error.message, /private|code/i);
    return true;
  });
  assert.equal(abortSignal.aborted, true);
  assert.deepEqual(clearedTimers, ["provider-timeout"]);
});

test("refresh-token exchange returns a renewed server-side token record", async () => {
  const calls = [];
  const provider = createDiscordOAuthProvider({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    guildId: "guild",
    now: () => new Date("2026-09-02T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({
        access_token: "renewed-access",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "renewed-refresh",
        scope: "identify guilds.members.read",
      });
    },
  });

  const refreshed = await provider.refreshAccessToken({ refreshToken: "refresh" });

  assert.deepEqual(refreshed, {
    accessToken: "renewed-access",
    refreshToken: "renewed-refresh",
    expiresAt: "2026-09-02T13:00:00.000Z",
  });
  assert.equal(calls[0].url, "https://discord.com/api/v10/oauth2/token");
  assert.equal(new URLSearchParams(calls[0].options.body).get("grant_type"), "refresh_token");
  assert.equal(new URLSearchParams(calls[0].options.body).get("refresh_token"), "refresh");
});
