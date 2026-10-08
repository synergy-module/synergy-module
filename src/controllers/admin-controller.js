import { ROUTE_BY_KEY } from "../models/navigation.js";
import { buildPageViewModel } from "../models/view-models.js";
import { renderPage } from "./page-controller.js";

const PUBLIC_ERRORS = Object.freeze({
  SELF_BAN_FORBIDDEN: Object.freeze({
    status: 409,
    message: "SELF BAN BLOCKED :: USE SIGN OUT",
  }),
  SESSION_INVALIDATION_FAILED: Object.freeze({
    status: 503,
    message: "SESSION CONTROL PARTIALLY FAILED :: REVIEW ACTIVE SESSIONS",
  }),
  BAN_NOT_FOUND: Object.freeze({
    status: 404,
    message: "BAN RECORD NOT FOUND",
  }),
  INDICATOR_REQUEST_NOT_FOUND: Object.freeze({
    status: 404,
    message: "INDICATOR REQUEST NOT FOUND",
  }),
  INVALID_DECISION: Object.freeze({
    status: 422,
    message: "INDICATOR DECISION MUST BE GRANTED OR DENIED",
  }),
  INDICATOR_REQUEST_NOT_PENDING: Object.freeze({
    status: 409,
    message: "INDICATOR REQUEST ALREADY DECIDED :: RESUBMIT TO REOPEN",
  }),
});

function isStandardForm(req) {
  return Boolean(req.is?.("application/x-www-form-urlencoded"));
}

async function findUser(adminService, userId) {
  return (await adminService.getDashboard()).users.find((user) => user.id === String(userId)) ?? {
    id: String(userId),
  };
}

function handleError(error, res, next) {
  const publicError = PUBLIC_ERRORS[error.code];
  if (!publicError) return next(error);
  return res.status(publicError.status).json({
    ok: false,
    error: error.code,
    message: publicError.message,
  });
}

export function createAdminController({ adminService }) {
  return {
    async show(req, res) {
      return renderPage(req, res, buildPageViewModel(ROUTE_BY_KEY.admin, {
        operator: req.session.operator,
        data: await adminService.getDashboard(),
      }));
    },

    async signOutUser(req, res, next) {
      const userId = req.params.id;
      const actor = req.session.operator;
      const actorId = actor.id;
      try {
        await adminService.signOutUser({ userId, actor, actorId });
        if (isStandardForm(req)) return res.redirect(303, "/admin");
        const selfSignedOut = String(userId) === String(actorId);
        return res.json({
          ok: true,
          user: await findUser(adminService, userId),
          selfSignedOut,
          ...(selfSignedOut ? { redirectTo: "/login" } : {}),
        });
      } catch (error) {
        return handleError(error, res, next);
      }
    },

    async banUser(req, res, next) {
      const userId = req.params.id;
      const actor = req.session.operator;
      const actorId = actor.id;
      try {
        await adminService.banUser({ userId, actor, actorId, reason: req.body?.reason ?? "" });
        if (isStandardForm(req)) return res.redirect(303, "/admin");
        return res.json({
          ok: true,
          user: await findUser(adminService, userId),
          selfSignedOut: false,
        });
      } catch (error) {
        return handleError(error, res, next);
      }
    },

    async unbanUser(req, res, next) {
      const userId = req.params.id;
      try {
        await adminService.unbanUser({
          userId,
          actor: req.session.operator,
          actorId: req.session.operator.id,
        });
        if (isStandardForm(req)) return res.redirect(303, "/admin");
        return res.json({ ok: true, user: await findUser(adminService, userId), selfSignedOut: false });
      } catch (error) {
        return handleError(error, res, next);
      }
    },

    async decideIndicatorRequest(req, res, next) {
      try {
        const request = await adminService.decideIndicatorRequest({
          userId: req.params.userId,
          actor: req.session.operator,
          actorId: req.session.operator.id,
          status: req.body?.status,
        });
        if (isStandardForm(req)) return res.redirect(303, "/admin");
        return res.json({ ok: true, request });
      } catch (error) {
        return handleError(error, res, next);
      }
    },
  };
}
