/** Coordinate a rotated Discord credential only with the browser login that
 * originally delegated it. Permissions and identity still use refreshRoles. */
export function createPlatformSessionDelegation({ tokenService, refreshRoles }) {
  return async function syncDelegation(req, res, next) {
    if (!req.session?.operator?.id) return refreshRoles(req, res, next);
    return tokenService.withAuthorizationLock(req.session.operator.id, async () => {
      try {
        const latest = await tokenService.browserAuthorization(req.session?.operator);
        if (latest) req.session.operator.discordAuth = latest;
      }
      catch { /* The normal Discord admission/refresh remains authoritative. */ }
      const before = req.session?.operator?.discordAuth?.accessToken;
      return refreshRoles(req, res, async error => {
        if (error) return next(error);
        try {
          if (req.session?.operator?.discordAuth?.accessToken !== before) await tokenService.rememberBrowserAuthorization(req.session?.operator);
        }
        catch { /* A failed delegation update must not interrupt a valid browser session. */ }
        next();
      });
    });
  };
}
