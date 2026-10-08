import { runLoginSequence, AUTH_LINES } from "./login-sequence.js";
import { startMatrix } from "./matrix-renderer.js";
import { startSphereRenderer } from "./sphere-renderer.js";
import { initializeDiscordLogin } from "./discord-login.js";
import { initializeColorTheme } from "./redline-theme.js";

function replaceEntryWithStream({ documentRef, entry, root, reducedMotion, redirectTo, windowRef, stopSphere }) {
  const stream = documentRef.createElement("div");
  stream.className = "auth-stream";
  entry.replaceWith(stream);
  let stopMatrix = () => {};

  return runLoginSequence({
    reducedMotion,
    onLine(line) {
      const entry = documentRef.createElement("div");
      entry.textContent = line;
      stream.appendChild(entry);
      if (line === AUTH_LINES.at(-1)) {
        for (const message of ["> decrypting interface", "> mounting data streams"]) {
          const progress = documentRef.createElement("div");
          progress.textContent = message;
          stream.appendChild(progress);
        }
      }
    },
    onGrant() {
      stopSphere();
      const screen = documentRef.createElement("div");
      screen.className = "screen";
      if (reducedMotion) {
        screen.style.background = "var(--c-bg-deep)";
      } else {
        const canvas = documentRef.createElement("canvas");
        canvas.className = "matrix-canvas";
        screen.appendChild(canvas);
        stopMatrix = startMatrix(canvas);
      }
      const granted = documentRef.createElement("div");
      granted.className = "auth-granted";
      granted.style.cssText = "position: fixed; inset: 0; z-index: 9600";
      const label = documentRef.createElement("span");
      label.textContent = "ACCESS GRANTED";
      granted.appendChild(label);
      root.replaceChildren(screen, granted);
    },
    onComplete() {
      stopMatrix();
      windowRef.location.href = redirectTo;
    },
  });
}

export function initializeLoginController({
  documentRef = document,
  windowRef = window,
  fetchImpl = window.fetch.bind(window),
} = {}) {
  const completion = documentRef.querySelector("[data-auth-complete]");
  const discordEntry = documentRef.querySelector("[data-discord-entry]");
  const popupResult = documentRef.querySelector("[data-discord-popup-result]");
  if (!completion && !discordEntry && !popupResult) return null;
  if (popupResult) {
    try { windowRef.close(); } catch { /* A visible link remains if the browser refuses to close. */ }
    return null;
  }

  const root = documentRef.querySelector("[data-login-root]");
  const stopTheme = initializeColorTheme({ documentRef, windowRef });
  const reducedMotion = Boolean(windowRef.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  let stopSphere = startSphereRenderer({ documentRef, windowRef, reducedMotion });
  const stopLoginSphere = () => {
    stopSphere();
    stopSphere = () => {};
  };
  const discord = initializeDiscordLogin({
    documentRef, windowRef, fetchImpl,
    onComplete: (entry) => replaceEntryWithStream({
      documentRef, entry, root, reducedMotion, redirectTo: "/home", windowRef, stopSphere: stopLoginSphere,
    }),
  });
  if (completion) {
    void replaceEntryWithStream({
      documentRef,
      entry: completion,
      root,
      reducedMotion,
      redirectTo: completion.dataset.redirectTo || "/home",
      windowRef,
      stopSphere: stopLoginSphere,
    });
  }
  return {
    dispose() {
      discord?.dispose();
      stopLoginSphere();
      stopTheme();
    },
  };
}

if (typeof document !== "undefined" && document.querySelector("[data-login-root]")) initializeLoginController();
