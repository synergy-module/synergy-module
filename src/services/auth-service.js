import { randomUUID } from "node:crypto";
import { ACCESS_ERRORS } from "../models/access.js";
import { createRolePolicy } from "./role-policy.js";

function createAuthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function isExpired(expiresAt, now) {
  const expiry = new Date(expiresAt).getTime();
  const currentValue = now();
  const current = currentValue instanceof Date ? currentValue.getTime() : new Date(currentValue).getTime();
  return Number.isFinite(expiry) && expiry <= current;
}

export function createAuthService({
  mode = "discord",
  discordProvider,
  discordAccessPolicy = "roles",
  rolePolicy = createRolePolicy({ roleIds: {} }),
  userRepository = { upsert: (record) => record },
  banRepository = { isBanned: () => false },
  now = () => new Date(),
} = {}) {
  if (mode !== "discord") {
    throw new Error("Discord authentication is required; AUTH_MODE must be discord");
  }
  function buildOperator({ identity, authMode, roles, capabilities, discordAuth, rolesSyncedAt, lastSignedInAt }) {
    return {
      id: identity.id,
      username: identity.username,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      authMode,
      roles,
      capabilities,
      rolesSyncedAt: rolesSyncedAt ?? toIsoTimestamp(now()),
      ...(lastSignedInAt ? { lastSignedInAt } : {}),
      discordAuth,
    };
  }

  async function persistSafeSnapshot(operator) {
    const { discordAuth: _discordAuth, ...snapshot } = operator;
    await userRepository.upsert(snapshot);
  }

  async function rejectIfBanned(id) {
    if (await banRepository.isBanned(id)) {
      throw createAuthError(ACCESS_ERRORS.ACCOUNT_BANNED, "This account is not permitted to sign in");
    }
  }

  function rejectIfNoBaseAccess(access) {
    if (!rolePolicy.hasBaseAccess(access)) {
      throw createAuthError("ACCESS_REVOKED", "This account no longer has access");
    }
  }

  async function assertOperatorAdmission(operator) {
    if (operator?.authMode !== "discord") {
      throw createAuthError("ACCESS_REVOKED", "Sign in through Discord to continue");
    }
    await rejectIfBanned(operator.id);
    rejectIfNoBaseAccess(operator);
    return operator;
  }

  function discordAccess(member) {
    // This opt-in beta policy preserves the former gateway's full guild preview.
    // Only call it after Discord's live member endpoint confirms membership.
    return discordAccessPolicy === "beta-guild"
      ? rolePolicy.fromRoleNames(["Developer"])
      : rolePolicy.fromDiscordRoleIds(member.roles);
  }

  function beginDiscord() {
    const state = randomUUID();
    return { state, authorizationUrl: discordProvider.buildAuthorizationUrl({ state }) };
  }

  async function completeDiscord({ code } = {}) {
    const discordAuth = await discordProvider.exchangeCode({ code });
    const [identity, member] = await Promise.all([
      discordProvider.getCurrentUser({ accessToken: discordAuth.accessToken }),
      discordProvider.getCurrentGuildMember({ accessToken: discordAuth.accessToken }),
    ]);
    await rejectIfBanned(identity.id);

    const access = discordAccess(member);
    rejectIfNoBaseAccess(access);
    const signedInAt = toIsoTimestamp(now());
    const operator = buildOperator({
      identity,
      authMode: "discord",
      roles: access.roles,
      capabilities: access.capabilities,
      rolesSyncedAt: signedInAt,
      lastSignedInAt: signedInAt,
      discordAuth,
    });
    await persistSafeSnapshot(operator);
    return operator;
  }

  async function refreshOperator(operator) {
    if (operator?.authMode !== "discord") {
      throw createAuthError("ACCESS_REVOKED", "Sign in through Discord to continue");
    }
    await rejectIfBanned(operator.id);
    let discordAuth = operator.discordAuth;
    if (isExpired(discordAuth?.expiresAt, now)) {
      discordAuth = await discordProvider.refreshAccessToken({ refreshToken: discordAuth.refreshToken });
    }

    const member = await discordProvider.getCurrentGuildMember({ accessToken: discordAuth?.accessToken });
    const access = discordAccess(member);
    rejectIfNoBaseAccess(access);
    const refreshed = buildOperator({
      identity: {
        id: operator.id,
        username: operator.username,
        displayName: operator.displayName,
        avatarUrl: operator.avatarUrl,
      },
      authMode: "discord",
      roles: access.roles,
      capabilities: access.capabilities,
      lastSignedInAt: operator.lastSignedInAt,
      discordAuth,
    });
    await persistSafeSnapshot(refreshed);
    return refreshed;
  }

  async function revokeOperatorToken(operator) {
    if (operator?.discordAuth?.accessToken) {
      await discordProvider.revokeToken({ token: operator.discordAuth.accessToken });
    }
  }

  return {
    assertOperatorAdmission,
    beginDiscord,
    completeDiscord,
    refreshOperator,
    revokeOperatorToken,
  };
}
