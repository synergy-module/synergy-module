import { ROUTE_BY_KEY } from "../models/navigation.js";
import { buildPageViewModel } from "../models/view-models.js";
import { normalizeTradingViewUrl } from "../config/indicator-catalog.js";
import { renderPage } from "./page-controller.js";

const PUBLIC_ERRORS = Object.freeze({
  CONSENT_REQUIRED: Object.freeze({
    status: 422,
    message: "EXPLICIT CONSENT IS REQUIRED",
  }),
  TRADINGVIEW_USERNAME_INVALID: Object.freeze({
    status: 422,
    message: "TRADINGVIEW USERNAME MUST BE 3–64 LETTERS, NUMBERS, UNDERSCORES, OR HYPHENS",
  }),
  INDICATORS_UNAVAILABLE: Object.freeze({
    status: 503,
    message: "NO ACTIVE INDICATORS ARE CONFIGURED",
  }),
});

function isStandardForm(req) {
  return Boolean(req.is?.("application/x-www-form-urlencoded"));
}

function catalogForRendering(catalog) {
  return Object.freeze(catalog.map((indicator) => Object.freeze({
    ...indicator,
    tradingViewUrl: normalizeTradingViewUrl(indicator.tradingViewUrl),
  })));
}

export function createIndicatorController({ indicatorAccessService }) {
  return {
    async show(req, res) {
      const memberView = await indicatorAccessService.getMemberView(req.session.operator.id);
      const notice = req.session.indicatorNotice ?? null;
      if (notice) delete req.session.indicatorNotice;
      return renderPage(req, res, buildPageViewModel(ROUTE_BY_KEY.indicators, {
        operator: req.session.operator,
        data: { ...memberView, catalog: catalogForRendering(memberView.catalog), notice },
      }));
    },

    async requestAll(req, res, next) {
      try {
        const request = await indicatorAccessService.requestAll({
          operator: req.session.operator,
          tradingViewUsername: req.body?.tradingViewUsername,
          consent: req.body?.consent === true || req.body?.consent === "true",
        });
        if (isStandardForm(req)) return res.redirect(303, "/indicators");
        return res.status(201).json({ ok: true, request });
      } catch (error) {
        const publicError = PUBLIC_ERRORS[error.code];
        if (!publicError) return next(error);
        if (isStandardForm(req)) {
          req.session.indicatorNotice = { error: error.code, message: publicError.message };
          return res.redirect(303, "/indicators");
        }
        return res.status(publicError.status).json({
          ok: false,
          error: error.code,
          message: publicError.message,
        });
      }
    },
  };
}
