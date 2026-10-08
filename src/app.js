import express from "express";
import session from "express-session";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDiscordOAuthProvider } from "./providers/discord-oauth-provider.js";
import { createInMemoryBanRepository } from "./repositories/in-memory-ban-repository.js";
import { createInMemoryIndicatorRequestRepository } from "./repositories/in-memory-indicator-request-repository.js";
import { createInMemorySessionRegistry } from "./repositories/in-memory-session-registry.js";
import { createInMemoryUserRepository } from "./repositories/in-memory-user-repository.js";
import { createAuthService } from "./services/auth-service.js";
import { createAdminService } from "./services/admin-service.js";
import { createIndicatorAccessService } from "./services/indicator-access-service.js";
import { createRolePolicy } from "./services/role-policy.js";
import { createIndicatorCatalog } from "./config/indicator-catalog.js";
import { normalizeAuthConfig, readAuthConfig } from "./config/auth-config.js";
import { ensureCsrfToken } from "./security/csrf.js";
import { requireAuth } from "./middleware/require-auth.js";
import { createRefreshRoles } from "./middleware/refresh-roles.js";
import { fragmentRequest } from "./middleware/fragment-request.js";
import { createAuthRoutes } from "./routes/auth-routes.js";
import { createAdminRoutes } from "./routes/admin-routes.js";
import { createPageRoutes } from "./routes/page-routes.js";
import { createJournalRoutes } from "./routes/journal-routes.js";
import { createMarketNewsService } from "./services/market-news-service.js";
import { createEconomiciumCalendarProvider } from "./providers/economicium-calendar-provider.js";
import { CAPABILITIES, LOGIN_ERROR_MESSAGES, MAX_ROLE_SNAPSHOT_AGE_MS } from "./models/access.js";
import { createInMemoryJournalRepository } from "./repositories/in-memory-journal-repository.js";
import { createTraderAIProvider } from "./providers/trader-ai-provider.js";
import { createTraderService } from "./services/trader-service.js";
import { createTraderRoutes } from "./routes/trader-routes.js";
import { createMemoryBrainRepository } from "./agent-brain/brain-repository.js";
import { createBrainKnowledge } from "./agent-brain/brain-knowledge.js";
import { createBrainModelGateway } from "./agent-brain/brain-model-gateway.js";
import { createBrainTools } from "./agent-brain/brain-tools.js";
import { createBrainService } from "./agent-brain/brain-service.js";
import { createBrainRoutes } from "./routes/brain-routes.js";
import { createRobinhoodService } from "./brokers/robinhood-service.js";
import { createRobinhoodRoutes } from "./routes/robinhood-routes.js";
import { createAssetManifest } from "./runtime/asset-manifest.js";
import { createMemoryWorkspaceRepository } from "./settings/workspace-repository.js";
import { createWorkspaceSettingsService } from "./settings/workspace-settings-service.js";
import { createWorkspaceAIProvider } from "./providers/workspace-ai-provider.js";
import { createSettingsRoutes } from "./routes/settings-routes.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(sourceDirectory, "..", "public");
const assetManifest = createAssetManifest(publicDirectory);

export function createApp({
  sessionSecret,
  sessionStore,
  environment = process.env.NODE_ENV ?? "development",
  appEnvironment = process.env.APP_ENVIRONMENT,
  trustProxy,
  authConfig,
  authService,
  discordProvider,
  userRepository = createInMemoryUserRepository(),
  banRepository = createInMemoryBanRepository(),
  sessionRegistry = createInMemorySessionRegistry(),
  indicatorRequestRepository = createInMemoryIndicatorRequestRepository(),
  indicatorCatalog,
  indicatorAccessService,
  adminService,
  marketNewsService = createMarketNewsService({
    provider: createEconomiciumCalendarProvider(),
  }),
  journalRepository = createInMemoryJournalRepository(),
  traderAIProvider,
  traderService,
  brainRepository = createMemoryBrainRepository(),
  brainKnowledge,
  brainModelGateway,
  brainTools,
  brainService,
  brainEvaluator,
  robinhoodService,
  brokerRepository,
  workspaceRepository = createMemoryWorkspaceRepository(),
  workspaceSettingsService,
  integrationsEncryptionKey,
  readinessCheck = async () => true,
  configureRoutes,
  logger = console,
} = {}) {
  const resolvedAuthConfig = authConfig == null ? readAuthConfig({
    env: { ...process.env, APP_ENVIRONMENT: appEnvironment, ...(sessionSecret ? { SESSION_SECRET: sessionSecret } : {}) },
    nodeEnvironment: environment,
  }) : normalizeAuthConfig(authConfig, {
    nodeEnvironment: environment,
    appEnvironment,
    sessionSecret: sessionSecret || authConfig.sessionSecret || process.env.SESSION_SECRET,
  });
  const secret = resolvedAuthConfig.sessionSecret || undefined;
  if (!sessionStore && environment === "production") {
    throw new Error("sessionStore is required in production");
  }
  const resolvedSessionStore = sessionStore ?? new session.MemoryStore();
  const resolvedDiscordProvider = discordProvider ?? createDiscordOAuthProvider(resolvedAuthConfig.discord);
  const resolvedAuthService = authService ?? createAuthService({
    mode: resolvedAuthConfig.mode,
    discordProvider: resolvedDiscordProvider,
    discordAccessPolicy: resolvedAuthConfig.discord?.accessPolicy ?? "roles",
    discordGuildId: resolvedAuthConfig.discord.guildId,
    requiredDiscordRoleId: resolvedAuthConfig.discord.requiredRoleId,
    rolePolicy: createRolePolicy({ roleIds: resolvedAuthConfig.discord?.roleIds ?? {} }),
    userRepository,
    banRepository,
  });
  const refreshRoles = createRefreshRoles({
    authService: resolvedAuthService,
    refreshAfterMs: resolvedAuthConfig.roleRefreshMs,
    sessionRegistry,
  });
  const resolvedIndicatorCatalog = indicatorCatalog ?? createIndicatorCatalog({
    authMode: resolvedAuthConfig.mode,
  });
  const resolvedIndicatorAccessService = indicatorAccessService ?? createIndicatorAccessService({
    catalog: resolvedIndicatorCatalog,
    requestRepository: indicatorRequestRepository,
  });
  const resolvedAdminService = adminService ?? createAdminService({
    userRepository,
    banRepository,
    sessionRegistry,
    requestRepository: indicatorRequestRepository,
    sessionStore: resolvedSessionStore,
    catalog: resolvedIndicatorCatalog,
    assertOperatorAdmission: (operator) => resolvedAuthService.assertOperatorAdmission?.(operator),
  });

  const baseAIProvider = traderAIProvider ?? createTraderAIProvider();
  const credentialSecret = [integrationsEncryptionKey, process.env.INTEGRATIONS_ENCRYPTION_KEY, secret]
    .find((value) => typeof value === "string" && value.trim());
  const resolvedSettingsService = workspaceSettingsService ?? createWorkspaceSettingsService({
    repository: workspaceRepository, aiProvider: baseAIProvider,
    encryptionSecret: credentialSecret,
  });
  const resolvedAIProvider = createWorkspaceAIProvider({ settingsService: resolvedSettingsService, fallbackProvider: baseAIProvider });
  const resolvedRobinhoodService = robinhoodService ?? createRobinhoodService({ repository: brokerRepository });
  const resolvedBrainKnowledge = brainKnowledge ?? createBrainKnowledge({ repository: brainRepository });
  const resolvedBrainGateway = brainModelGateway ?? createBrainModelGateway({ aiProvider: resolvedAIProvider, repository: brainRepository });
  const canReadBrainJournal = async (ownerId) => {
    try {
      const operator = await userRepository.findById(ownerId);
      if (!operator || operator.authMode !== resolvedAuthConfig.mode
        || !operator.capabilities?.includes(CAPABILITIES.BASE)
        || !operator.capabilities?.includes(CAPABILITIES.JOURNAL)
        || await banRepository.isBanned?.(ownerId)) return false;
      await resolvedAuthService.assertOperatorAdmission?.(operator);
      if (operator.authMode === "discord") {
        const age = Date.now() - new Date(operator.rolesSyncedAt).valueOf();
        if (!Number.isFinite(age) || age < 0 || age > MAX_ROLE_SNAPSHOT_AGE_MS) return false;
      }
      return true;
    } catch { return false; }
  };
  const resolvedBrainTools = brainTools ?? createBrainTools({
    knowledge: resolvedBrainKnowledge, journalRepository, marketNewsService, canReadJournal: canReadBrainJournal,
    robinhoodService: resolvedRobinhoodService,
  });
  const resolvedBrainService = brainService ?? createBrainService({
    repository: brainRepository, knowledge: resolvedBrainKnowledge,
    modelGateway: resolvedBrainGateway, tools: resolvedBrainTools,
  });

  const app = express();
  app.locals.assetPath = assetManifest.assetPath;
  app.locals.authConfig = resolvedAuthConfig;
  app.locals.authService = resolvedAuthService;
  app.locals.userRepository = userRepository;
  app.locals.banRepository = banRepository;
  app.locals.sessionRegistry = sessionRegistry;
  app.locals.sessionStore = resolvedSessionStore;
  app.locals.indicatorCatalog = resolvedIndicatorCatalog;
  app.locals.indicatorRequestRepository = indicatorRequestRepository;
  app.locals.adminService = resolvedAdminService;
  app.locals.brainService = resolvedBrainService;
  app.locals.brainRepository = brainRepository;
  app.locals.brainKnowledge = resolvedBrainKnowledge;
  app.locals.brainTools = resolvedBrainTools;
  app.locals.robinhoodService = resolvedRobinhoodService;
  app.locals.workspaceSettingsService = resolvedSettingsService;
  app.locals.workspaceRepository = workspaceRepository;
  app.set("trust proxy", trustProxy ?? (environment === "production" ? 1 : false));
  app.set("view engine", "ejs");
  app.set("views", path.join(sourceDirectory, "..", "views"));
  app.use(["/brain", "/research", "/settings", "/accounts", "/api/settings", "/api/brain", "/api/robinhood", "/auth/robinhood"], (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(`/assets/${assetManifest.version}`, express.static(publicDirectory, {
    maxAge: environment === "production" ? "1y" : 0, immutable: environment === "production", index: false,
  }));
  // Legacy unversioned URLs must revalidate; the HTML uses deployment-specific URLs.
  app.use(express.static(publicDirectory, { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
  app.use(session({
    store: resolvedSessionStore,
    // Verify existing local cookies during the rename; deployments use SESSION_SECRET.
    secret: secret ?? ["synergy-module-local-development-secret", "omensite-local-development-secret"],
    resave: false,
    rolling: true,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: environment === "production",
    },
  }));

  // A session admitted by a previous authentication mode must sign in again.
  app.use((req, res, next) => {
    if (!req.session.operator || req.session.operator.authMode === resolvedAuthConfig.mode) return next();
    const { id } = req.session.operator;
    const previousSessionId = req.sessionID;
    req.session.regenerate(async (error) => {
      if (error) return next(error);
      try {
        await sessionRegistry.unregister(id, previousSessionId);
      } catch (error) {
        return next(error);
      }
      return next();
    });
  });

  app.use(fragmentRequest);
  app.get("/health", async (req, res) => {
    try {
      const ready = await readinessCheck();
      return res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "unavailable" });
    } catch {
      return res.status(503).json({ status: "unavailable" });
    }
  });
  app.use((req, res, next) => {
    if (req.session.operator) res.locals.csrfToken = ensureCsrfToken(req);
    next();
  });
  app.get("/", (req, res) => res.redirect(req.session.operator ? "/home" : "/login"));
  app.get("/login", (req, res) => req.session.operator
    ? res.redirect("/home")
    : res.render("layouts/login", {
        authMode: resolvedAuthConfig.mode,
        complete: false,
        authError: typeof req.query.error === "string"
          ? LOGIN_ERROR_MESSAGES[req.query.error] ?? null
          : null,
      }));
  app.use("/auth", createAuthRoutes({
    authConfig: resolvedAuthConfig,
    authService: resolvedAuthService,
    sessionRegistry,
    logger,
  }));
  configureRoutes?.(app);
  app.use(requireAuth, refreshRoles);
  // Populate durable identity records for valid sessions created before the storage migration.
  app.use(async (req, res, next) => {
    if (userRepository.getStorageStatus?.().persistent && req.session.operator) {
      const operator = req.session.operator;
      if (!await userRepository.findById(operator.id)) {
        const { discordAuth: _credentials, ...snapshot } = operator;
        await userRepository.upsert({ ...snapshot, firstSeenAt: operator.lastSignedInAt });
      }
    }
    next();
  });
  app.use(createAdminRoutes({ adminService: resolvedAdminService }));
  app.use(createRobinhoodRoutes({ robinhoodService: resolvedRobinhoodService }));
  app.use(createSettingsRoutes({ settingsService: resolvedSettingsService, logger }));
  app.use(createPageRoutes({ marketNewsService, logger }));
  app.use(createTraderRoutes({
    traderService: traderService ?? createTraderService({
      aiProvider: resolvedAIProvider,
      marketNewsService,
    }),
    logger,
  }));
  app.use(createBrainRoutes({
    brainService: resolvedBrainService, brainKnowledge: resolvedBrainKnowledge,
    brainTools: resolvedBrainTools, brainEvaluator, robinhoodService: resolvedRobinhoodService, logger,
  }));
  app.use(createJournalRoutes({ journalRepository }));

  app.use((req, res) => res.status(404).render("pages/error", {
    fragment: req.isSynergyModuleFragment, status: 404, heading: "ROUTE NOT FOUND",
    message: "REQUESTED COORDINATE DOES NOT EXIST",
  }));
  app.use((error, req, res, next) => {
    logger.error?.("Unhandled application error");
    if (res.headersSent) return next(error);
    if (req.path.startsWith("/api/brain/")) {
      if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "BRAIN_INVALID_INPUT", message: "The request body must be valid JSON." });
      if (error?.type === "entity.too.large") return res.status(413).json({ error: "BRAIN_INVALID_INPUT", message: "The request body exceeds the size limit." });
      return res.status(500).json({ error: "BRAIN_UNAVAILABLE", message: "The agent brain is unavailable. Try again." });
    }
    res.status(500).render("pages/error", {
      fragment: req.isSynergyModuleFragment, status: 500, heading: "INTERNAL TERMINAL ERROR",
      message: "SERVER FAULT CONTAINED :: TRY AGAIN",
    });
  });

  return app;
}
