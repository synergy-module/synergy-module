import { Router } from "express";
import { createAuthController } from "../controllers/auth-controller.js";
import { requireCsrf } from "../security/csrf.js";

const notFound = (_req, res) => res.sendStatus(404);

export function createAuthRoutes({ authConfig, authService, sessionRegistry, logger }) {
  if (authConfig.mode !== "discord") {
    throw new Error("Discord authentication is required; AUTH_MODE must be discord");
  }
  const router = Router();
  const authController = createAuthController({ authService, sessionRegistry, logger });
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });

  router.post("/login", notFound);
  router.get("/discord", authController.beginDiscord);
  router.get("/discord/callback", authController.completeDiscord);
  router.get("/discord/status", authController.popupStatus);
  router.get("/discord/popup-complete", authController.showPopupComplete);
  router.get("/complete", authController.showComplete);
  router.post("/logout", requireCsrf, authController.logout);

  return router;
}
