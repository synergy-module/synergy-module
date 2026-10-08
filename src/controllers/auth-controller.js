import { ensureCsrfToken } from "../security/csrf.js";

const POPUP_ATTEMPT = /^[a-zA-Z0-9_-]{20,80}$/;
const POPUP_LIFETIME_MS = 5 * 60_000;

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => error ? reject(error) : resolve());
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
}

function discordFailureLocation(error) {
  if (error?.code === "ACCOUNT_BANNED") return "/login?error=account_banned";
  if (error?.code === "ACCESS_REVOKED") return "/login?error=access_revoked";
  if ([
    "DISCORD_HTTP_ERROR",
    "DISCORD_TIMEOUT",
    "DISCORD_REQUEST_FAILED",
    "DISCORD_INVALID_RESPONSE",
  ].includes(error?.code)) return "/login?error=discord_auth_failed";
  return null;
}

export function createAuthController({ authService, sessionRegistry, logger = console }) {
  async function finishPopup(req, res, popup, error = null) {
    req.session.discordPopup = { ...popup, status: error ? "error" : "complete", error };
    await saveSession(req);
    return res.redirect("/auth/discord/popup-complete");
  }

  async function establishOperator(req, operator, { complete = false } = {}) {
    const previousOperator = req.session.operator;
    const previousSessionId = req.sessionID;
    await regenerateSession(req);
    if (previousOperator?.id) {
      await sessionRegistry.unregister(previousOperator.id, previousSessionId);
    }
    try {
      await authService.assertOperatorAdmission?.(operator);
    } catch (error) {
      try {
        // Retain an empty session so popup failures can reach the waiting terminal.
        await regenerateSession(req);
      } catch {
        // The admission failure is authoritative and safe to report.
      }
      throw error;
    }
    req.session.operator = operator;
    req.session.authComplete = complete;
    ensureCsrfToken(req);
    await sessionRegistry.register(operator.id, req.sessionID);
  }

  return {
    async beginDiscord(req, res, next) {
      try {
        const { state, authorizationUrl } = authService.beginDiscord();
        req.session.oauthState = state;
        req.session.discordPopup = typeof req.query.popup === "string" && POPUP_ATTEMPT.test(req.query.popup)
          ? { id: req.query.popup, status: "pending", startedAt: Date.now() }
          : null;
        await saveSession(req);
        return res.redirect(authorizationUrl);
      } catch (error) {
        return next(error);
      }
    },

    async completeDiscord(req, res, next) {
      const expectedState = req.session.oauthState;
      const popup = req.session.discordPopup?.status === "pending" ? req.session.discordPopup : null;
      const fail = (error) => popup
        ? finishPopup(req, res, popup, error)
        : res.redirect(`/login?error=${error}`);
      delete req.session.oauthState;
      if (expectedState) await saveSession(req);
      const suppliedState = typeof req.query.state === "string" ? req.query.state : "";
      if (!expectedState || suppliedState !== expectedState) {
        return fail("invalid_oauth_state");
      }

      if (popup && Date.now() - popup.startedAt > POPUP_LIFETIME_MS) return fail("invalid_oauth_state");
      if (req.query.error === "access_denied") return fail("discord_cancelled");

      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!code) return fail("discord_auth_failed");

      try {
        const operator = await authService.completeDiscord({ code });
        await establishOperator(req, operator, { complete: !popup });
        if (popup) return finishPopup(req, res, popup);
        return res.redirect("/auth/complete");
      } catch (error) {
        const location = discordFailureLocation(error);
        if (!location) {
          if (!popup) return next(error);
          logger.error?.("Unhandled Discord popup authentication error");
          return fail("discord_auth_failed");
        }
        logger.warn?.("Discord OAuth callback failed", { code: error.code });
        return fail(location.split("error=")[1]);
      }
    },

    async popupStatus(req, res) {
      res.set("Cache-Control", "no-store");
      const popup = req.session.discordPopup;
      if (!popup || typeof req.query.attempt !== "string" || popup.id !== req.query.attempt) {
        return res.json({ status: "pending" });
      }
      if (Date.now() - popup.startedAt > POPUP_LIFETIME_MS) {
        return res.json({ status: "error", error: "invalid_oauth_state" });
      }
      if (popup.status === "complete") {
        try {
          if (req.session.operator?.authMode !== "discord" || await sessionRegistry.isRevoked?.(req.sessionID)) {
            return res.json({ status: "error", error: "access_revoked" });
          }
          await authService.assertOperatorAdmission?.(req.session.operator);
        } catch {
          return res.json({ status: "error", error: "access_revoked" });
        }
        return res.json({ status: "complete" });
      }
      return res.json({ status: popup.status, ...(popup.error ? { error: popup.error } : {}) });
    },

    showPopupComplete(req, res) {
      res.set("Cache-Control", "no-store");
      if (!["complete", "error"].includes(req.session.discordPopup?.status)) return res.redirect("/login");
      return res.render("layouts/login", {
        authMode: "discord", complete: false, authError: null,
        popupResult: req.session.discordPopup.status,
      });
    },

    showComplete(req, res) {
      if (!req.session.operator) return res.redirect("/login");
      if (!req.session.authComplete) return res.redirect("/home");
      delete req.session.authComplete;
      return res.render("layouts/login", { authMode: "discord", complete: true, authError: null });
    },

    async logout(req, res, next) {
      const operator = req.session.operator;
      const sessionId = req.sessionID;
      try {
        try {
          await sessionRegistry.markRevoked?.(sessionId);
        } catch {
          // Cookie clearing and session destruction remain authoritative.
        }
        delete req.session.operator;
        res.clearCookie("connect.sid", { path: "/" });
        try {
          await authService.revokeOperatorToken?.(operator);
        } catch {
          // Local logout must not depend on provider availability.
        }
        await destroySession(req);
        try {
          if (operator?.id) await sessionRegistry.unregister(operator.id, sessionId);
        } catch {
          // The backing session is already gone.
        }
        return res.json({ ok: true, redirectTo: "/login" });
      } catch (error) {
        return next(error);
      }
    },
  };
}
