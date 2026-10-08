/* ============================================================
   SYNERGY MODULE // retro-terminal trading platform
   Vanilla single-page build. No framework, no build step.

   Scope of this build: full route scaffold, cinematic auth
   sequence, and every terminal interaction — but NO seeded
   data. Journal history, market feed, news calendar, alert
   rules and trigger logs all start empty and render as
   terminal standby / empty states. The journal is fully
   functional; entries the operator creates persist to
   localStorage.
   ============================================================ */
(() => {
  "use strict";

  /* --------------------------------------------------------
     Constants
     -------------------------------------------------------- */
  const SYNERGY_MODULE_ASCII = `SYNERGY MODULE
AGENTIC TRADING TERMINAL`;

  const AUTH_LINES = [
    "HANDSHAKE........OK",
    "TOKEN_CHECK......OK",
    "ROUTE_MAP........OK",
    "UI_KERNEL........OK",
    "MOTION_SYSTEM....OK",
    "ACCESS_GRANT.....OK",
  ];

  const NAV = [
    { key: "home",         title: "HOME",           uri: "home",                        tree: "|-- home" },
    { key: "indicators",   title: "INDICATORS",     uri: "indicators",                  tree: "|-- indicators" },
    { key: "market-news",  title: "MARKET NEWS",    uri: "market-news",                 tree: "|-- market-news" },
    { key: "alerts-ict",   title: "ALERTS :: ICT",  uri: "alerts/ict",                  tree: "|-- alerts/ict" },
    { key: "alerts-sr",    title: "ALERTS :: S&R",  uri: "alerts/support-resistance",   tree: "|-- alerts/s-r" },
    { key: "journal",      title: "JOURNAL",        uri: "journal",                     tree: "`-- journal" },
  ];

  const ROUTE_META = {
    home:        { title: "HOME",                uri: "home",                       desc: "Landing dashboard, system status, recent activity, important summaries, and quick links." },
    indicators:  { title: "INDICATORS",          uri: "indicators",                 desc: "TradingView indicator access, entitlement status, instructions, and related resources." },
    "market-news":{ title: "MARKET NEWS",        uri: "market-news",                desc: "Important financial events, red-folder news, orange-folder news, and market reports." },
    "alerts-ict":{ title: "ALERTS :: ICT",       uri: "alerts/ict",                 desc: "Alerts for ICT-based conditions, concepts, and future strategy-specific signals." },
    "alerts-sr": { title: "ALERTS :: S&R",       uri: "alerts/support-resistance",  desc: "Support and resistance alerts presented with the same live terminal-style feedback." },
    journal:     { title: "JOURNAL",             uri: "journal",                    desc: "Create, review, organize, and publicly share structured trade entries." },
    "journal-new":   { title: "NEW JOURNAL ENTRY",   uri: "journal/new",            desc: "Capture direction, timing, price, confluences, evidence and notes for one trade." },
    "journal-public":{ title: "PUBLIC JOURNAL ENTRY",uri: "journal/public",         desc: "The shareable public record and webhook embed generated on submission." },
  };

  const ROUTE_HASH = {
    home: "#/home",
    indicators: "#/indicators",
    "market-news": "#/market-news",
    "alerts-ict": "#/alerts/ict",
    "alerts-sr": "#/alerts/sr",
    journal: "#/journal",
    "journal-new": "#/journal/new",
  };

  const CONFLUENCE_OPTIONS = [
    "MSS", "FVG", "HTF PD Array", "Liquidity Sweep",
    "Order Block", "Breaker Block", "Support Level", "Resistance Level",
  ];

  const TICKER_SEGMENTS = [
    "MARKET FEED :: STANDBY",
    "NO SYMBOLS SUBSCRIBED",
    "AWAITING DATA SOURCE",
    "FEED SOCKET :: CLOSED",
  ];

  const JOURNAL_KEY = "synergy-module.journal.v1";
  const AUTH_KEY = "synergy-module.auth";

  /* --------------------------------------------------------
     State
     -------------------------------------------------------- */
  const A = {
    phase: "form",            // form | authenticating | granted | done
    username: "",
    password: "",
    authLines: [],
    loginErr: "",
    loginShake: false,

    route: null,
    viewingId: null,

    uptimeSec: 0,
    sphereAngle: 0,
    reducedMotion: false,

    journal: [],
    newEntry: freshEntry(),
    screenshotCount: 0,
    newsFilter: "all",

    toastText: "",
    _toast: null,
    _nav1: null,
    _nav2: null,
    _matrixRAF: null,
  };

  function freshEntry() {
    return { direction: "long", entryTime: "", entryPrice: "", exitPrice: "", notes: "", confluences: [] };
  }

  /* --------------------------------------------------------
     Tiny DOM helpers
     -------------------------------------------------------- */
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "hidden") node.hidden = !!v;
        else if (k === "spellcheck") node.spellcheck = v === true || v === "true";
        else if (k in node && k !== "list") { try { node[k] = v; } catch (_) { node.setAttribute(k, v); } }
        else node.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const fmtUptime = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;

  /* --------------------------------------------------------
     ASCII sphere renderer (ported from the design prototype)
     -------------------------------------------------------- */
  const SPHERE_RAMP = [".", "\u00b7", ":", "+", "*", "#", "@"];

  function buildSphereFrame(cols, rows, angle) {
    const buf = [], zbuf = [];
    for (let r = 0; r < rows; r++) { buf.push(new Array(cols).fill(" ")); zbuf.push(new Array(cols).fill(0)); }
    const cx = cols / 2, cy = rows / 2;
    const camDist = 3.2;
    const R = Math.min(cols, rows * 2) * 0.46 * camDist;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);

    function projected(theta, phi) {
      const x0 = Math.cos(phi) * Math.cos(theta), y0 = Math.sin(phi), z0 = Math.cos(phi) * Math.sin(theta);
      const x1 = x0 * cosA + z0 * sinA, z1 = -x0 * sinA + z0 * cosA;
      const y2 = y0, z2 = z1;
      const ooz = 1 / (camDist + z2);
      return { px: Math.round(cx + x1 * R * ooz), py: Math.round(cy - y2 * R * 0.5 * ooz), ooz, z2 };
    }

    function plotBody(theta, phi) {
      const { px, py, ooz, z2 } = projected(theta, phi);
      if (px < 0 || px >= cols || py < 0 || py >= rows || ooz <= zbuf[py][px]) return;
      zbuf[py][px] = ooz;
      const t = Math.max(0, Math.min(1, (z2 + 1) / 2));
      buf[py][px] = SPHERE_RAMP[Math.floor(t * (SPHERE_RAMP.length - 1))];
    }

    const MERIDIANS = 16, PARALLELS = 8;
    for (let m = 0; m < MERIDIANS; m++) {
      const theta = (m / MERIDIANS) * Math.PI * 2;
      for (let p = 0; p <= 64; p++) plotBody(theta, -Math.PI / 2 + (p / 64) * Math.PI);
    }
    for (let l = 1; l < PARALLELS; l++) {
      const phi = -Math.PI / 2 + (l / PARALLELS) * Math.PI;
      for (let t = 0; t <= 110; t++) plotBody((t / 110) * Math.PI * 2, phi);
    }

    const WORD = "SYNERGY MODULE";
    const cyi = Math.round(cy);
    const beltHalfRows = Math.max(1, Math.round(rows * 0.1));
    for (let r = cyi - beltHalfRows; r <= cyi + beltHalfRows; r++) {
      if (r < 0 || r >= rows) continue;
      for (let c = 0; c < cols; c++) buf[r][c] = " ";
    }
    const ztext = new Array(rows).fill(0).map(() => new Array(cols).fill(-Infinity));
    const wordArc = 1.5;
    for (let li = 0; li < WORD.length; li++) {
      const theta = (li / (WORD.length - 1) - 0.5) * wordArc;
      const { px, py, ooz, z2 } = projected(theta, 0);
      if (z2 >= -0.05 || px < 0 || px >= cols || py < 0 || py >= rows) continue;
      if (ooz > ztext[cyi][px]) { ztext[cyi][px] = ooz; buf[cyi][px] = WORD[li]; }
    }

    return buf.map((row) => row.join("")).join("\n");
  }

  const sphereFrame = (c, r) => buildSphereFrame(c, r, A.sphereAngle);

  function updateSpheres() {
    A.sphereAngle += 0.09;
    qsa("[data-sphere]").forEach((pre) => {
      pre.textContent = buildSphereFrame(+pre.dataset.cols, +pre.dataset.rows, A.sphereAngle);
    });
  }

  /* --------------------------------------------------------
     Matrix rain (access-granted transition)
     -------------------------------------------------------- */
  function startMatrix(canvas) {
    const ctx = canvas.getContext("2d");
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    const chars = "01\u30a2\u30ab\u30b5\u30bf\u30ca\u30cf\u30de\u30e4\u30e9\u30efSYNERGYMODULE";
    const cols = Math.max(1, Math.floor(canvas.width / 14));
    const drops = new Array(cols).fill(0);
    const draw = () => {
      ctx.fillStyle = "rgba(8,12,10,0.15)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = "14px monospace";
      for (let i = 0; i < cols; i++) {
        const ch = chars[(Math.random() * chars.length) | 0];
        ctx.fillStyle = Math.random() > 0.94 ? "#dfffe8" : "rgba(60,230,130,0.85)";
        ctx.fillText(ch, i * 14, drops[i] * 14);
        drops[i] = drops[i] * 14 > canvas.height && Math.random() > 0.975 ? 0 : drops[i] + 1;
      }
      A._matrixRAF = requestAnimationFrame(draw);
    };
    A._matrixRAF = requestAnimationFrame(draw);
  }

  function stopMatrix() {
    if (A._matrixRAF) cancelAnimationFrame(A._matrixRAF);
    A._matrixRAF = null;
  }

  /* --------------------------------------------------------
     Storage
     -------------------------------------------------------- */
  function readMigratedStorage(storage, key, legacyKey) {
    const current = storage.getItem(key);
    if (current != null) return current;
    const legacy = storage.getItem(legacyKey);
    if (legacy != null) {
      try { storage.setItem(key, legacy); storage.removeItem(legacyKey); } catch (_) {}
    }
    return legacy;
  }

  function loadJournal() {
    try {
      const raw = readMigratedStorage(localStorage, JOURNAL_KEY, "omensite.journal.v1");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }

  function persistJournal() {
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(A.journal)); } catch (_) {}
  }

  /* --------------------------------------------------------
     Login screen + auth sequence
     -------------------------------------------------------- */
  function renderLogin() {
    const app = qs("#app");
    clear(app);

    if (A.phase === "granted") {
      const screen = el("div", { class: "screen" });
      if (!A.reducedMotion) {
        const cv = el("canvas", { class: "matrix-canvas" });
        screen.appendChild(cv);
        app.appendChild(screen);
        startMatrix(cv);
      } else {
        screen.style.background = "var(--c-bg-deep)";
        app.appendChild(screen);
      }
      app.appendChild(
        el("div", { class: "auth-granted", style: { position: "fixed", inset: "0", zIndex: "9600" } },
          el("span", {}, "ACCESS GRANTED"))
      );
      return;
    }

    const login = el("div", { class: "login" });
    login.appendChild(el("pre", {
      class: "login-sphere", "data-sphere": "", dataset: { cols: "34", rows: "12" },
    }, sphereFrame(34, 12)));

    const card = el("div", { class: "login-card" + (A.loginShake ? " shake" : "") });
    card.appendChild(el("pre", { class: "login-banner" }, SYNERGY_MODULE_ASCII));
    card.appendChild(el("div", { class: "login-sub" }, "SYNERGY MODULE TRADING TERMINAL v2.4 :: RESTRICTED ACCESS"));

    if (A.phase === "form") {
      const form = el("div", { class: "login-form" });
      form.appendChild(el("div", { class: "login-prompt" }, "> identify yourself to continue"));

      const user = el("input", { type: "text", placeholder: "operator_id", value: A.username, autocomplete: "off", spellcheck: "false" });
      user.addEventListener("input", (e) => { A.username = e.target.value; });
      form.appendChild(el("label", { class: "field" }, "USER", user));

      const pass = el("input", { type: "password", placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", value: A.password, autocomplete: "off" });
      pass.addEventListener("input", (e) => { A.password = e.target.value; });
      pass.addEventListener("keydown", (e) => { if (e.key === "Enter") submitLogin(); });
      form.appendChild(el("label", { class: "field" }, "PASSKEY", pass));

      if (A.loginErr) form.appendChild(el("div", { class: "login-err" }, A.loginErr));

      form.appendChild(el("button", {
        class: "btn btn-primary btn-login", type: "button", onClick: submitLogin,
      }, "[ LOGIN ]"));

      form.appendChild(el("div", { class: "login-fineprint" }, "SESSION WILL BE ENCRYPTED. UNAUTHORIZED ACCESS IS LOGGED."));
      card.appendChild(form);
    } else if (A.phase === "authenticating") {
      const stream = el("div", { class: "auth-stream" });
      A.authLines.forEach((l) => stream.appendChild(el("div", {}, l)));
      if (A.authLines.length >= AUTH_LINES.length) {
        stream.appendChild(el("div", {}, "> decrypting interface"));
        stream.appendChild(el("div", {}, "> mounting data streams"));
      }
      card.appendChild(stream);
    }

    login.appendChild(card);
    app.appendChild(login);
  }

  function submitLogin() {
    if (A.phase !== "form") return;
    if (!A.username.trim() || !A.password.trim()) {
      A.loginErr = "> ERR :: CREDENTIALS REQUIRED — USER AND PASSKEY";
      A.loginShake = true;
      renderLogin();
      setTimeout(() => { A.loginShake = false; }, 420);
      return;
    }

    A.loginErr = "";
    A.phase = "authenticating";
    A.authLines = [];
    renderLogin();

    const step = A.reducedMotion ? 80 : 230;
    AUTH_LINES.forEach((line, i) => {
      setTimeout(() => {
        if (A.phase !== "authenticating") return;
        A.authLines = [...A.authLines, line];
        renderLogin();
      }, step * (i + 1));
    });

    const grantAt = step * AUTH_LINES.length + (A.reducedMotion ? 140 : 360);
    const doneAt = grantAt + (A.reducedMotion ? 650 : 1700);

    setTimeout(() => { A.phase = "granted"; renderLogin(); }, grantAt);
    setTimeout(() => {
      stopMatrix();
      A.phase = "done";
      try { sessionStorage.setItem(AUTH_KEY, "1"); } catch (_) {}
      enterApp();
    }, doneAt);
  }

  function logout() {
    try { sessionStorage.removeItem("omensite.auth"); sessionStorage.removeItem(AUTH_KEY); } catch (_) {}
    stopMatrix();
    A.phase = "form";
    A.username = ""; A.password = ""; A.authLines = ""; A.authLines = [];
    A.route = null; A.viewingId = null;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { location.hash = ""; }
    renderLogin();
  }

  /* --------------------------------------------------------
     App shell
     -------------------------------------------------------- */
  function enterApp() {
    const app = qs("#app");
    clear(app);
    app.appendChild(buildShell());

    let key = keyFromHash();
    if (!location.hash) {
      try { history.replaceState(null, "", "#/home"); } catch (_) {}
      key = "home";
    }
    A.route = null;
    doNavigate(key);
  }

  function buildShell() {
    const shell = el("div", { class: "shell" });

    /* status bar */
    const ticker = el("div", { class: "ticker" });
    const track = el("div", { class: "ticker-track" });
    const segs = [...TICKER_SEGMENTS, ...TICKER_SEGMENTS];
    segs.forEach((s) => track.appendChild(el("span", {}, el("span", {}, s))));
    ticker.appendChild(track);

    const statusbar = el("div", { class: "statusbar" },
      el("button", { class: "navtoggle", type: "button", title: "Toggle navigation", onClick: toggleNav }, "[≡]"),
      el("div", { class: "statusbar-live" }, el("span", { class: "dot idle" }), "LIVE FEED"),
      ticker,
      el("div", { class: "statusbar-session" }, "SESSION 01 / AUTHORIZED"),
      el("div", { class: "statusbar-clock js-clock" }, new Date().toTimeString().slice(0, 8)),
    );

    /* sidebar */
    const sidebar = el("aside", { class: "sidebar" });
    sidebar.appendChild(el("pre", {
      class: "sidebar-sphere", "data-sphere": "", dataset: { cols: "26", rows: "11" },
    }, sphereFrame(26, 11)));
    sidebar.appendChild(el("div", { class: "sidebar-brand" }, "SYNERGY MODULE"));
    sidebar.appendChild(el("div", { class: "sidebar-prompt" }, "root@synergy-module:~$"));

    NAV.forEach((item) => {
      sidebar.appendChild(el("div", {
        class: "navitem", dataset: { navkey: item.key }, role: "link", tabindex: "0",
        onClick: () => navigate(item.key),
        onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(item.key); } },
      }, item.tree));
    });

    sidebar.appendChild(el("div", { class: "sidebar-foot" },
      el("div", {}, "UPTIME ", el("span", { class: "js-uptime" }, fmtUptime(A.uptimeSec))),
      el("div", {}, "ALERTS ARMED 0"),
      el("div", {}, "SYNC: ", el("span", { class: "standby" }, "STANDBY")),
      el("button", { class: "btn btn-danger sidebar-logout", type: "button", onClick: logout }, "[ LOGOUT ]"),
    ));

    const body = el("div", { class: "body" },
      sidebar,
      el("div", { class: "scrim", onClick: closeNav }),
      el("div", { class: "main" }),
    );

    shell.appendChild(statusbar);
    shell.appendChild(body);
    return shell;
  }

  function toggleNav() { const b = qs(".body"); if (b) b.classList.toggle("nav-open"); }
  function closeNav() { const b = qs(".body"); if (b) b.classList.remove("nav-open"); }

  /* --------------------------------------------------------
     Routing
     -------------------------------------------------------- */
  function keyFromHash() {
    const h = location.hash.replace(/^#\/?/, "").trim();
    if (!h || h === "home") return "home";
    if (h === "indicators") return "indicators";
    if (h === "market-news") return "market-news";
    if (h === "alerts/ict") return "alerts-ict";
    if (h === "alerts/sr" || h === "alerts/support-resistance") return "alerts-sr";
    if (h === "journal") return "journal";
    if (h === "journal/new") return "journal-new";
    if (h.startsWith("journal/")) { A.viewingId = h.slice("journal/".length); return "journal-public"; }
    return "home";
  }

  function navigate(key) {
    closeNav();
    const hash = ROUTE_HASH[key];
    if (hash && location.hash !== hash) location.hash = hash;
    else doNavigate(key);
  }

  function doNavigate(key) {
    if (A.phase !== "done") return;
    A.route = key;
    if (A._nav1) clearTimeout(A._nav1);
    if (A._nav2) clearTimeout(A._nav2);

    showRouteXn(ROUTE_META[key] ? ROUTE_META[key].title : "HOME");
    const swap = A.reducedMotion ? 60 : 260;
    const done = A.reducedMotion ? 120 : 640;
    A._nav1 = setTimeout(renderRoute, swap);
    A._nav2 = setTimeout(hideRouteXn, done);
  }

  function showRouteXn(title) {
    const main = qs(".main");
    if (!main) return;
    hideRouteXn();
    const center = el("div", { class: "route-xn-center" },
      el("div", { class: "route-xn-title" }, "> ROUTING::" + title),
      el("div", { class: "route-xn-buffer" }, "BUFFER ",
        el("span", { class: "route-xn-bar" }, el("span", {}))),
    );
    const xn = el("div", { class: "route-xn", "aria-hidden": "true" },
      el("div", { class: "route-xn-glitch route-xn-g1" }),
      el("div", { class: "route-xn-glitch route-xn-g2" }),
      center,
    );
    main._xn = xn;
    main.appendChild(xn);
  }

  function hideRouteXn() {
    const main = qs(".main");
    if (main && main._xn) { main._xn.remove(); main._xn = null; }
  }

  function renderRoute() {
    const main = qs(".main");
    if (!main) return;
    const prev = main.querySelector(".route");
    if (prev) prev.remove();

    const builder = ROUTES[A.route] || ROUTES.home;
    main.insertBefore(builder(), main._xn || null);
    main.scrollTop = 0;
    updateNavActive();
  }

  function updateNavActive() {
    const activeKey =
      A.route === "journal-new" || A.route === "journal-public" ? "journal" : A.route;
    qsa(".navitem").forEach((n) => n.classList.toggle("active", n.dataset.navkey === activeKey));
  }

  /* --------------------------------------------------------
     Route frame + shared bits
     -------------------------------------------------------- */
  function routeFrame(key, ...body) {
    const m = ROUTE_META[key] || ROUTE_META.home;
    const head = el("div", { class: "route-head" },
      el("div", {},
        el("div", { class: "route-uri" }, "synergy-module://" + m.uri),
        el("div", { class: "route-title" }, m.title),
        el("div", { class: "route-desc" }, m.desc),
      ),
      el("div", { class: "toast js-toast", hidden: !A.toastText }, A.toastText ? "[SYSTEM] " + A.toastText : ""),
    );
    const route = el("div", { class: "route" }, head);
    body.flat().forEach((n) => { if (n) route.appendChild(n); });
    return route;
  }

  function emptyState(...lines) {
    const box = el("div", { class: "empty" });
    lines.flat().forEach((ln, i) => {
      if (i) box.appendChild(el("br"));
      box.appendChild(el("span", { class: i === 0 ? "blip" : "" }, ln));
    });
    return box;
  }

  function sectionLabel(text) { return el("div", { class: "section-label" }, text); }

  function showToast(text) {
    A.toastText = text;
    const slot = qs(".js-toast");
    if (slot) { slot.textContent = "[SYSTEM] " + text; slot.hidden = false; }
    if (A._toast) clearTimeout(A._toast);
    A._toast = setTimeout(() => {
      A.toastText = "";
      const s = qs(".js-toast");
      if (s) { s.hidden = true; s.textContent = ""; }
    }, 2400);
  }

  async function copyText(text, msg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    } catch (_) {}
    showToast(msg);
  }

  /* --------------------------------------------------------
     Routes
     -------------------------------------------------------- */
  const ROUTES = {};

  ROUTES.home = () => {
    const stats = [
      { label: "ALERTS ARMED", value: "0", muted: true },
      { label: "JOURNAL ENTRIES", value: String(A.journal.length), muted: A.journal.length === 0 },
      { label: "MARKET FEED", value: "STANDBY", muted: true },
      { label: "UPTIME", value: Math.floor(A.uptimeSec / 60) + "m", muted: false, min: true },
    ];
    const statGrid = el("div", { class: "grid grid-4", style: { marginBottom: "26px" } });
    stats.forEach((s, i) => {
      statGrid.appendChild(el("div", { class: "stat", style: { animationDelay: i * 40 + "ms" } },
        el("div", { class: "stat-label" }, s.label),
        el("div", { class: "stat-value" + (s.muted ? " muted" : ""), ...(s.min ? { } : {}) },
          s.min ? el("span", { class: "js-uptime-min" }, s.value) : s.value),
      ));
    });

    const activity = el("div", { class: "panel" },
      el("div", { class: "panel-kicker" }, "> RECENT ACTIVITY"),
      emptyState("[ NO ACTIVITY RECORDED ]", "EVENT BUS IDLE :: STREAMS NOT MOUNTED"),
    );

    const quick = el("div", { class: "panel" }, el("div", { class: "panel-kicker" }, "> QUICK ACCESS"));
    NAV.filter((n) => n.key !== "home").forEach((n, i) => {
      quick.appendChild(el("div", {
        class: "quicklink", style: { animationDelay: i * 40 + "ms" },
        onClick: () => navigate(n.key),
      }, "./" + n.uri));
    });

    return routeFrame("home", statGrid, el("div", { class: "grid grid-2-1" }, activity, quick));
  };

  ROUTES.indicators = () => {
    const howto = el("div", { class: "panel howto" },
      el("div", { class: "panel-kicker" }, "> TRADINGVIEW ACCESS INSTRUCTIONS"),
      el("ol", {},
        el("li", {}, " copy the invite code issued to your operator ID"),
        el("li", {}, " open TradingView > indicators > invite-only scripts"),
        el("li", {}, " paste the code to unlock the entitlement"),
        el("li", {}, " entitlement syncs back to this terminal within 60s"),
      ),
      el("div", { class: "code-row" },
        el("div", { class: "code-field" }, "[ NO CODE ISSUED ]"),
        el("button", { class: "btn", type: "button", disabled: true }, "COPY"),
      ),
    );

    return routeFrame("indicators",
      sectionLabel("> INDICATOR ACCESS"),
      emptyState("[ NO INDICATORS PROVISIONED ]", "ENTITLEMENT SYNC PENDING :: INDICATOR ACCESS READY"),
      el("div", { style: { height: "24px" } }),
      howto,
    );
  };

  ROUTES["market-news"] = () => {
    const filters = ["all", "red", "orange"];
    const chips = el("div", { class: "chips" });
    filters.forEach((f) => {
      chips.appendChild(el("div", {
        class: "chip" + (A.newsFilter === f ? " active" : ""),
        onClick: () => { A.newsFilter = f; renderRoute(); },
      }, f.toUpperCase()));
    });

    return routeFrame("market-news",
      chips,
      emptyState("[ NO EVENTS ON CALENDAR ]", "NEWS FEED ON STANDBY :: RED / ORANGE FOLDERS EMPTY"),
    );
  };

  ROUTES["alerts-ict"] = () => routeFrame("alerts-ict",
    el("div", { class: "toolbar" },
      el("button", {
        class: "btn btn-primary", type: "button",
        onClick: () => showToast("ALERT ENGINE :: STANDBY :: MODULE PENDING"),
      }, "+ NEW RULE"),
    ),
    sectionLabel("> ICT RULES"),
    emptyState("[ NO ICT RULES CONFIGURED ]", "ALERT ENGINE STANDBY :: MSS / FVG / LIQUIDITY SWEEP"),
    el("div", { style: { height: "22px" } }),
    sectionLabel("> TRIGGER LOG"),
    emptyState("[ NO TRIGGERS LOGGED ]"),
  );

  ROUTES["alerts-sr"] = () => routeFrame("alerts-sr",
    el("div", { class: "toolbar" },
      el("button", {
        class: "btn btn-primary", type: "button",
        onClick: () => showToast("ALERT ENGINE :: STANDBY :: MODULE PENDING"),
      }, "+ NEW LEVEL"),
    ),
    sectionLabel("> SUPPORT / RESISTANCE LEVELS"),
    emptyState("[ NO LEVELS DEFINED ]", "ALERT ENGINE STANDBY :: AWAITING FIRST LEVEL"),
  );

  ROUTES.journal = () => {
    const toolbar = el("div", { class: "toolbar" },
      el("button", { class: "btn btn-primary", type: "button", onClick: () => navigate("journal-new") }, "+ NEW JOURNAL ENTRY"),
    );

    if (A.journal.length === 0) {
      return routeFrame("journal", toolbar,
        emptyState("[ NO ENTRIES LOGGED ]", "SUBMIT YOUR FIRST TRADE TO OPEN THE JOURNAL"));
    }

    const list = el("div", { class: "list" });
    A.journal.forEach((j, i) => {
      const dirColor = j.direction === "long" ? "t-green" : "t-red";
      list.appendChild(el("div", {
        class: "row", style: { cursor: "pointer", animationDelay: i * 40 + "ms" },
        onClick: () => { location.hash = "#/journal/" + j.id; },
      },
        el("span", { class: "tagbox " + dirColor }, j.direction.toUpperCase()),
        el("span", { style: { fontSize: "12px", color: "var(--c-text-mid)", flex: "none", width: "132px" } }, j.entryTime || "--"),
        el("span", { style: { fontSize: "12px", color: "var(--c-text-dim)", flex: "1" } }, (j.confluences || []).join(" / ") || "no confluences tagged"),
        el("span", { class: "row-mono " + (String(j.pl).startsWith("-") ? "pl-neg" : "pl-pos"), style: { flex: "none", fontSize: "14px" } }, j.pl),
      ));
    });

    return routeFrame("journal", toolbar, list);
  };

  ROUTES["journal-new"] = () => {
    const n = A.newEntry;

    /* direction toggle */
    const longOpt = el("div", { class: "dir-opt" + (n.direction === "long" ? " on-long" : "") }, "LONG");
    const shortOpt = el("div", { class: "dir-opt" + (n.direction === "short" ? " on-short" : "") }, "SHORT");
    longOpt.addEventListener("click", () => {
      n.direction = "long";
      longOpt.className = "dir-opt on-long";
      shortOpt.className = "dir-opt";
    });
    shortOpt.addEventListener("click", () => {
      n.direction = "short";
      shortOpt.className = "dir-opt on-short";
      longOpt.className = "dir-opt";
    });

    /* numeric / time fields */
    const mkField = (label, prop, placeholder) => {
      const input = el("input", { type: "text", placeholder, value: n[prop], autocomplete: "off", spellcheck: "false" });
      input.addEventListener("input", (e) => { n[prop] = e.target.value; });
      return el("label", { class: "field" }, label, input);
    };

    /* confluences */
    const confBlock = el("div", { class: "conf-block js-conf-block" });
    renderConfBlock(confBlock);

    /* screenshots */
    const drop = el("div", { class: "dropzone" });
    const file = el("input", { type: "file", multiple: true, accept: "image/*" });
    const dropLabelText = () => `[ DROP CHART EVIDENCE :: ${A.screenshotCount} ATTACHED ]`;
    const dropLabel = el("span", { class: "js-shotcount" }, dropLabelText());
    file.addEventListener("change", (e) => {
      A.screenshotCount = e.target.files ? e.target.files.length : 0;
      dropLabel.textContent = dropLabelText();
    });
    drop.appendChild(file);
    drop.appendChild(dropLabel);

    /* notes */
    const notes = el("textarea", { rows: "4", placeholder: "trade thesis, execution commentary, lessons..." });
    notes.value = n.notes;
    notes.addEventListener("input", (e) => { n.notes = e.target.value; });

    const form = el("div", { class: "jform" },
      el("div", { class: "dir-toggle" }, longOpt, shortOpt),
      el("div", { class: "jgrid3" },
        mkField("ENTRY TIME", "entryTime", "08/31 14:32"),
        mkField("ENTRY PRICE", "entryPrice", "6392.25"),
        mkField("EXIT PRICE", "exitPrice", "6381.75"),
      ),
      confBlock,
      el("label", { class: "field" }, "SCREENSHOTS", drop),
      el("label", { class: "field" }, "NOTES", notes),
      el("div", { class: "form-actions" },
        el("button", { class: "btn", type: "button", onClick: () => showToast("DRAFT HELD IN SESSION") }, "SAVE DRAFT"),
        el("button", { class: "btn btn-solid", type: "button", onClick: submitEntry }, "SUBMIT ENTRY"),
      ),
    );

    return routeFrame("journal-new", form);
  };

  function renderConfBlock(mount) {
    clear(mount);
    const n = A.newEntry;
    mount.appendChild(el("div", { class: "conf-label" }, "CONFLUENCES"));

    const chosen = el("div", { class: "conf-set" });
    n.confluences.forEach((c, idx) => {
      chosen.appendChild(el("div", {
        class: "conf-chip",
        onClick: () => { n.confluences.splice(idx, 1); renderConfBlock(mount); },
      }, c + " \u00d7"));
    });
    if (n.confluences.length === 0) {
      chosen.appendChild(el("span", { style: { fontSize: "11px", color: "var(--c-text-faint)" } }, "none selected"));
    }
    mount.appendChild(chosen);

    const opts = el("div", { class: "conf-set", style: { marginBottom: "0" } });
    CONFLUENCE_OPTIONS.filter((o) => !n.confluences.includes(o)).forEach((o) => {
      opts.appendChild(el("div", {
        class: "conf-opt",
        onClick: () => { n.confluences.push(o); renderConfBlock(mount); },
      }, "+ " + o));
    });
    mount.appendChild(opts);
  }

  function submitEntry() {
    const n = A.newEntry;
    const ep = parseFloat(n.entryPrice) || 0;
    const xp = parseFloat(n.exitPrice) || 0;
    const raw = n.direction === "long" ? xp - ep : ep - xp;
    const pl = (raw >= 0 ? "+" : "") + raw.toFixed(2);

    const entry = {
      id: String(Date.now()),
      direction: n.direction,
      entryTime: n.entryTime.trim() || "--",
      entryPrice: n.entryPrice.trim() || "0",
      exitPrice: n.exitPrice.trim() || "0",
      pl,
      notes: n.notes,
      confluences: n.confluences.slice(),
      screenshotCount: A.screenshotCount,
      createdAt: new Date().toISOString(),
    };

    A.journal = [entry, ...A.journal];
    persistJournal();

    A.newEntry = freshEntry();
    A.screenshotCount = 0;
    A.viewingId = entry.id;

    location.hash = "#/journal/" + entry.id;
    showToast("ENTRY SUBMITTED :: WEBHOOK DELIVERED");
  }

  ROUTES["journal-public"] = () => {
    const e = A.journal.find((j) => String(j.id) === String(A.viewingId));
    if (!e) {
      return routeFrame("journal-public",
        emptyState("[ ENTRY NOT FOUND ]", "the requested public record is not on this terminal"),
        el("div", { style: { marginTop: "18px" } },
          el("button", { class: "btn", type: "button", onClick: () => navigate("journal") }, "\u2190 BACK TO JOURNAL")),
      );
    }

    const dirClass = e.direction === "long" ? "pl-pos" : "pl-neg";
    const plClass = String(e.pl).startsWith("-") ? "pl-neg" : "pl-pos";
    const url = "synergymodule.app/journal/" + e.id;
    const embed =
      "TRADE: " + e.direction.toUpperCase() + "\n" +
      "ENTRY: " + e.entryPrice + "  EXIT: " + e.exitPrice + "\n" +
      "P&L: " + e.pl + "\n" +
      "CONFLUENCES: " + (e.confluences.join(" / ") || "none") + "\n" +
      "NOTES: " + (e.notes || "").slice(0, 60) + "\n" +
      "IMAGES: " + e.screenshotCount + " attachment(s)\n" +
      "PUBLIC ENTRY: " + url;

    const record = el("div", { class: "pub-record" },
      el("div", { class: "head" },
        el("span", { class: "tagbox " + (e.direction === "long" ? "t-green" : "t-red") }, e.direction.toUpperCase()),
        el("span", { class: "pl " + plClass }, e.pl),
      ),
      el("div", { class: "meta" }, "ENTRY " + e.entryPrice + " \u2192 EXIT " + e.exitPrice + " :: " + e.entryTime),
      el("div", { class: "conf" }, e.confluences.length
        ? e.confluences.map((c) => el("span", {}, c))
        : el("span", {}, "no confluences tagged")),
      el("div", { class: "notes" }, e.notes || "(no notes recorded)"),
      el("div", { class: "shots" }, e.screenshotCount + " SCREENSHOT(S) ATTACHED"),
    );

    return routeFrame("journal-public",
      el("div", { class: "pub" },
        el("div", { class: "pub-embed" },
          el("div", { class: "pub-embed-label" }, "// WEBHOOK EMBED DELIVERED"),
          el("pre", {}, embed),
        ),
        el("div", { class: "pub-link" },
          el("span", { class: "lbl" }, "PUBLIC LINK"),
          el("span", { class: "url" }, url),
          el("button", { class: "btn", type: "button", onClick: () => copyText(url, "LINK COPIED") }, "COPY"),
        ),
        sectionLabel("> PUBLIC ENTRY RECORD"),
        record,
        el("div", { style: { marginTop: "18px" } },
          el("button", { class: "btn", type: "button", onClick: () => navigate("journal") }, "\u2190 BACK TO JOURNAL")),
      ),
    );
  };

  /* --------------------------------------------------------
     Clocks
     -------------------------------------------------------- */
  function tick() {
    A.uptimeSec += 1;
    const clk = new Date().toTimeString().slice(0, 8);
    const c = qs(".js-clock"); if (c) c.textContent = clk;
    const u = qs(".js-uptime"); if (u) u.textContent = fmtUptime(A.uptimeSec);
    const um = qs(".js-uptime-min"); if (um) um.textContent = Math.floor(A.uptimeSec / 60) + "m";
  }

  /* --------------------------------------------------------
     Boot
     -------------------------------------------------------- */
  function boot() {
    A.reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    A.journal = loadJournal();

    setInterval(updateSpheres, 60);
    setInterval(tick, 1000);

    window.addEventListener("hashchange", () => {
      if (A.phase !== "done") return;
      doNavigate(keyFromHash());
    });

    let authed = false;
    try { authed = readMigratedStorage(sessionStorage, AUTH_KEY, "omensite.auth") === "1"; } catch (_) {}

    if (authed) { A.phase = "done"; enterApp(); }
    else { A.phase = "form"; renderLogin(); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
