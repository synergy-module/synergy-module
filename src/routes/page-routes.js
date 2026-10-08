import { Router } from "express";
import { createMarketNewsController } from "../controllers/market-news-controller.js";
import { createPageController } from "../controllers/page-controller.js";
import { ROUTE_BY_KEY } from "../models/navigation.js";
import { requireCapability } from "../middleware/require-capability.js";

export function createPageRoutes({ marketNewsService, logger } = {}) {
  const router = Router();
  const pageController = createPageController();
  for (const key of ["home", "research", "accounts", "settings"]) {
    const route = ROUTE_BY_KEY[key];
    router.get(route.path, requireCapability(route.capability), pageController.show(route));
  }
  const marketNews = createMarketNewsController({ marketNewsService, logger });
  const marketNewsRoute = ROUTE_BY_KEY["market-news"];
  router.get(marketNewsRoute.path, requireCapability(marketNewsRoute.capability), marketNews.show(marketNewsRoute));
  router.get("/api/market-news/events", requireCapability(marketNewsRoute.capability), marketNews.events);
  return router;
}
