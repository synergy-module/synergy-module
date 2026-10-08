import { normalizeTradingViewUrl } from "../config/indicator-catalog.js";

function adminError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function safeUserSnapshot(user, { banRepository, sessionRegistry }) {
  const [ban, activeSessions] = await Promise.all([banRepository.findByUserId(user.id), sessionRegistry.activeCount(user.id)]);
  return {
    id: String(user.id),
    username: user.username ?? "",
    displayName: user.displayName ?? user.username ?? "",
    avatarUrl: user.avatarUrl ?? null,
    authMode: user.authMode ?? "unknown",
    roles: [...(user.roles ?? [])],
    capabilities: [...(user.capabilities ?? [])],
    rolesSyncedAt: user.rolesSyncedAt ?? null,
    lastSignedInAt: user.lastSignedInAt ?? null,
    firstSeenAt: user.firstSeenAt ?? null,
    lastSeenAt: user.lastSeenAt ?? null,
    banned: Boolean(ban),
    ban: ban ? {
      actorId: ban.actorId,
      reason: ban.reason ?? "",
      bannedAt: ban.bannedAt,
    } : null,
    activeSessions,
  };
}

export function createAdminService({
  userRepository,
  banRepository,
  sessionRegistry,
  requestRepository,
  sessionStore,
  catalog = [],
  assertOperatorAdmission = () => {},
} = {}) {
  const indicatorsById = new Map(catalog.map((indicator) => [indicator.id, {
    id: indicator.id,
    name: indicator.name,
    tradingViewUrl: indicator.active ? normalizeTradingViewUrl(indicator.tradingViewUrl) : null,
  }]));

  async function invalidateSessions(userId) {
    const normalizedUserId = String(userId);
    const sessionIds = await sessionRegistry.listSessionIds(normalizedUserId);
    await Promise.all(sessionIds.map((sessionId) => sessionRegistry.markRevoked?.(sessionId)));
    const outcomes = await Promise.allSettled(sessionIds.map((sessionId) => new Promise((resolve, reject) => {
      sessionStore.destroy(sessionId, (error) => error ? reject(error) : resolve(sessionId));
    })));

    let failed = false;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "fulfilled") {
        await sessionRegistry.unregister(normalizedUserId, sessionIds[index]);
      } else {
        failed = true;
      }
    }
    if (failed) {
      throw adminError("SESSION_INVALIDATION_FAILED", "One or more sessions could not be invalidated");
    }
    return sessionIds.length;
  }

  async function admittedActor({ actor, actorId }) {
    const normalizedActorId = String(actor?.id ?? actorId);
    if (await banRepository.isBanned(normalizedActorId)) {
      throw adminError("ACCOUNT_BANNED", "Administrator account is banned");
    }
    if (actor) await assertOperatorAdmission(actor);
    return normalizedActorId;
  }

  return {
    async getDashboard() {
      const [users, requests] = await Promise.all([userRepository.list(), requestRepository.list()]);
      const repositories = [userRepository, banRepository, sessionRegistry, requestRepository];
      const persistent = repositories.every((repository) => repository.getStorageStatus?.().persistent === true);
      const storageKinds = new Set(repositories.map((repository) => repository.getStorageStatus?.().kind ?? "memory"));
      return {
        storage: { kind: persistent ? (storageKinds.size === 1 ? [...storageKinds][0] : "mixed") : "memory", persistent },
        users: await Promise.all(users.map((user) => safeUserSnapshot(user, { banRepository, sessionRegistry }))),
        requests: requests.map((request) => ({
          ...request,
          indicators: request.indicatorIds.map((id) => indicatorsById.get(id) ?? {
            id,
            name: id,
            tradingViewUrl: null,
          }),
        })),
      };
    },

    async signOutUser({ userId, actor, actorId }) {
      await admittedActor({ actor, actorId });
      const normalizedUserId = String(userId);
      const signedOutSessions = await invalidateSessions(normalizedUserId);
      return { userId: normalizedUserId, signedOutSessions };
    },

    async banUser({ userId, actor, actorId, reason = "" }) {
      const normalizedUserId = String(userId);
      const normalizedActorId = await admittedActor({ actor, actorId });
      if (normalizedUserId === normalizedActorId) {
        throw adminError("SELF_BAN_FORBIDDEN", "Administrators cannot ban their own identity");
      }
      const ban = await banRepository.ban({
        userId: normalizedUserId,
        actorId: normalizedActorId,
        reason: String(reason).trim(),
      });
      await invalidateSessions(normalizedUserId);
      return { ...ban, banned: true };
    },

    async unbanUser({ userId, actor, actorId }) {
      await admittedActor({ actor, actorId });
      const normalizedUserId = String(userId);
      await banRepository.unban({ userId: normalizedUserId });
      return { userId: normalizedUserId, banned: false };
    },

    async decideIndicatorRequest({ userId, actor, actorId, status }) {
      const normalizedActorId = await admittedActor({ actor, actorId });
      if (status !== "GRANTED" && status !== "DENIED") {
        throw adminError("INVALID_DECISION", "Invalid indicator request decision");
      }
      const existing = await requestRepository.findByUserId(String(userId));
      if (existing && existing.status !== "PENDING") {
        throw adminError("INDICATOR_REQUEST_NOT_PENDING", "Indicator request is not pending");
      }
      return requestRepository.decide({
        userId: String(userId),
        actorId: normalizedActorId,
        status,
      });
    },
  };
}
