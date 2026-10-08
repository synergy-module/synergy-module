const POLL_MS = 800;
const TIMEOUT_MS = 5 * 60_000;
const ERRORS = Object.freeze({
  invalid_oauth_state: "AUTHENTICATION EXPIRED :: PLEASE TRY AGAIN",
  discord_cancelled: "AUTHENTICATION CANCELLED :: TRY AGAIN WHEN READY",
  discord_auth_failed: "DISCORD UNAVAILABLE :: PLEASE TRY AGAIN",
  account_banned: "ACCESS FAILED :: ACCOUNT BANNED",
  access_revoked: "ACCESS FAILED :: REQUIRED ROLE NOT PRESENT",
});

// The server session carries the result. No tokens or window messages cross origins,
// and completion still works when Discord or the gateway isolates the popup's opener.
export function initializeDiscordLogin({ documentRef, windowRef, fetchImpl, onComplete }) {
  const entry = documentRef.querySelector("[data-discord-entry]");
  if (!entry) return null;
  const login = entry.querySelector("[data-discord-login]");
  const status = entry.querySelector("[data-discord-status]");
  const error = entry.querySelector("[data-login-error]");
  const cancel = entry.querySelector("[data-discord-cancel]");
  const fallback = entry.querySelector("[data-discord-fallback]");
  let active = null;
  let disposed = false;

  function stop() {
    const attempt = active;
    active = null;
    if (!attempt) return;
    windowRef.clearTimeout(attempt.timer);
    attempt.abort?.abort();
    try { attempt.popup.close(); } catch { /* An isolated popup closes itself on return. */ }
  }

  function reset(message) {
    stop();
    login.removeAttribute("aria-disabled");
    login.textContent = "[ SIGN IN WITH DISCORD ]";
    cancel.hidden = true;
    fallback.hidden = false;
    status.textContent = message;
    login.focus();
  }

  async function poll(attempt) {
    if (active !== attempt || disposed) return;
    if (Date.now() - attempt.startedAt >= TIMEOUT_MS) {
      reset("AUTHENTICATION TIMED OUT :: RETRY OR CONTINUE IN THIS TAB");
      return;
    }
    attempt.abort = new AbortController();
    // A stalled connection must not leave the terminal waiting indefinitely.
    const requestTimeout = windowRef.setTimeout(() => attempt.abort?.abort(), 5000);
    try {
      const response = await fetchImpl(`/auth/discord/status?attempt=${encodeURIComponent(attempt.id)}`, {
        credentials: "same-origin", cache: "no-store", signal: attempt.abort.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Status unavailable");
      const result = await response.json();
      if (active !== attempt || disposed) return;
      if (result.status === "complete") {
        stop();
        cancel.hidden = true;
        fallback.hidden = true;
        status.textContent = "IDENTITY CONFIRMED :: INITIALIZING TERMINAL";
        void onComplete(entry);
        return;
      }
      if (result.status === "error") {
        reset("AUTHENTICATION INTERRUPTED :: READY TO RETRY");
        error.textContent = ERRORS[result.error] ?? ERRORS.discord_auth_failed;
        error.hidden = false;
        return;
      }
    } catch {
      if (active === attempt && !disposed) status.textContent = "RECONNECTING :: WAITING FOR DISCORD CONFIRMATION";
    } finally {
      windowRef.clearTimeout(requestTimeout);
    }
    if (active === attempt && !disposed) attempt.timer = windowRef.setTimeout(() => poll(attempt), POLL_MS);
  }

  function onLogin(event) {
    if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (active) {
      try { active.popup.focus(); } catch { /* Keep the existing attempt running. */ }
      return;
    }
    error.hidden = true;
    let popup;
    try {
      const id = windowRef.crypto.randomUUID();
      const width = Math.min(500, windowRef.screen.availWidth || 500);
      const height = Math.min(760, windowRef.screen.availHeight || 760);
      const left = Math.max(0, (windowRef.screenX || 0) + ((windowRef.outerWidth || width) - width) / 2);
      const top = Math.max(0, (windowRef.screenY || 0) + ((windowRef.outerHeight || height) - height) / 2);
      popup = windowRef.open(`/auth/discord?popup=${encodeURIComponent(id)}`, "_blank", `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`);
      if (!popup) throw new Error("Popup blocked");
      popup.opener = null;
      active = { id, popup, startedAt: Date.now(), timer: null, abort: null };
      login.setAttribute("aria-disabled", "true");
      login.textContent = "[ AWAITING DISCORD ]";
      status.textContent = "COMPLETE SIGN-IN IN THE DISCORD WINDOW :: CLOSED IT? CANCEL / RETRY BELOW";
      cancel.hidden = false;
      fallback.hidden = true;
      // Delay the first read until the popup has had a chance to establish its session.
      const attempt = active;
      attempt.timer = windowRef.setTimeout(() => poll(attempt), POLL_MS);
    } catch {
      try { popup?.close(); } catch { /* The browser may already have closed it. */ }
      reset("POPUP UNAVAILABLE :: ALLOW POPUPS AND RETRY, OR CONTINUE IN THIS TAB");
    }
  }

  const onCancel = () => reset("AUTHENTICATION CANCELLED :: READY WHEN YOU ARE");
  const onPageHide = () => stop();
  login.addEventListener("click", onLogin);
  cancel.addEventListener("click", onCancel);
  windowRef.addEventListener("pagehide", onPageHide);
  return {
    dispose() {
      disposed = true;
      stop();
      login.removeEventListener("click", onLogin);
      cancel.removeEventListener("click", onCancel);
      windowRef.removeEventListener("pagehide", onPageHide);
    },
  };
}
