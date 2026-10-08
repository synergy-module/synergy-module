import { buildPageViewModel } from "../models/view-models.js";
import { renderPage } from "./page-controller.js";

const OFFLINE_CALENDAR = Object.freeze({
  state: "offline",
  events: [],
  updatedAt: null,
  range: null,
});

export function createMarketNewsController({ marketNewsService, logger = console }) {
  return {
    show(route) {
      return async (req, res) => {
        let calendar;
        try {
          calendar = await marketNewsService.getCurrentWeek();
        } catch (error) {
          logger.error?.(error);
          calendar = OFFLINE_CALENDAR;
        }
        return renderPage(req, res, buildPageViewModel(route, {
          operator: req.session.operator,
          data: { calendar },
        }));
      };
    },
    async events(req, res) {
      try {
        const calendar = await marketNewsService.getCurrentWeek({ force: req.query.refresh === "1" });
        return res.json({ ok: true, calendar });
      } catch (error) {
        logger.error?.(error);
        return res.status(503).json({ ok: false, calendar: OFFLINE_CALENDAR });
      }
    },
  };
}
