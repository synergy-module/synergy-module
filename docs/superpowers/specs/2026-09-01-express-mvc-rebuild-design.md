# Synergy Module Express MVC Rebuild Design

## Objective

Rebuild the existing three-file Synergy Module trading terminal as a Node.js and Express MVC application without changing its accepted visual design or interaction character. The finished application must use clean server routes, focused model/view/controller boundaries, and progressive fragment navigation while retaining the current glitch transitions, cinematic login handshake, `ACCESS GRANTED` state, matrix effect, responsive shell, and journal workflow.

## Scope

The rebuild covers the existing UI and behavior:

- Demo authentication and logout.
- Persistent terminal shell with status bar, sidebar, CRT effects, and ASCII sphere.
- Dashboard, indicators, market-news, ICT alerts, support/resistance alerts, journal list, new journal entry, and public journal entry screens.
- Route transition overlay and buffer/glitch animation.
- Journal entry creation, P&L calculation, local persistence, and public-record rendering.
- Filters, toasts, copy interaction, mobile navigation, keyboard access, and reduced-motion handling.

The rebuild does not add Discord OAuth, PostgreSQL, real market feeds, alert persistence, indicator provisioning, webhook delivery, or other new product behavior. Those integrations remain later phases.

## Selected Architecture

Use Node.js 24, Express 5, and EJS in a progressively enhanced server-rendered MVC architecture.

Controllers handle requests, call focused services and models, create view models, and select EJS views. EJS views own presentation markup. Server models and services own navigation metadata, view-model construction, and authentication abstraction. Browser journal domain modules temporarily own journal validation, calculation, and local persistence until the later PostgreSQL phase. Other static browser modules own animation, fragment navigation, and DOM interaction.

The server supports two rendering modes for application routes:

1. A direct visit or refresh returns the complete terminal document, including the shared shell and current page view.
2. An in-app fragment request returns only the requested page view and route metadata.

The browser keeps the shell mounted during in-app navigation. It plays the glitch transition, fetches the fragment, swaps the route content, updates history, and initializes page-specific controls. This preserves the existing SPA-like fluidity without duplicating route selection in a client-side application framework.

## Project Boundaries

The intended structure is:

```text
src/
  app.js
  server.js
  config/
  controllers/
    auth-controller.js
    page-controller.js
    journal-controller.js
  models/
    navigation.js
    view-models.js
  services/
    auth-service.js
  routes/
    auth-routes.js
    page-routes.js
    journal-routes.js
  middleware/
    require-auth.js
    fragment-request.js
views/
  layouts/
    app.ejs
    login.ejs
  pages/
    home.ejs
    indicators.ejs
    market-news.ejs
    alerts-ict.ejs
    alerts-sr.ejs
    journal-index.ejs
    journal-new.ejs
    journal-public.ejs
  partials/
    statusbar.ejs
    sidebar.ejs
    route-head.ejs
    empty-state.ejs
public/
  css/
  js/
    app-shell.js
    navigation-controller.js
    transition-controller.js
    login-controller.js
    sphere-renderer.js
    ui-utils.js
    journal/
      journal-entry.js
      journal-service.js
      local-storage-journal-repository.js
      journal-page-controller.js
  favicon.ico
tests/
  unit/
  integration/
  browser/
```

Files may be combined when a unit would otherwise contain only trivial forwarding code, but controllers, views, business models, and browser animation concerns must remain independently understandable.

## Routes

The hash routes are replaced with clean URLs:

| Route | Controller responsibility | View |
| --- | --- | --- |
| `/` | Redirect based on session state | None |
| `/login` | Render login or redirect authenticated sessions | `login.ejs` |
| `POST /auth/login` | Validate non-empty demo credentials and establish a session | JSON result |
| `POST /auth/logout` | Destroy the session | JSON result or redirect |
| `/home` | Build dashboard view model | `home.ejs` |
| `/indicators` | Build indicator-access view model | `indicators.ejs` |
| `/market-news` | Build market-news/filter view model | `market-news.ejs` |
| `/alerts/ict` | Build ICT alert view model | `alerts-ict.ejs` |
| `/alerts/support-resistance` | Build S&R alert view model | `alerts-sr.ejs` |
| `/journal` | Render locally hydrated journal list shell | `journal-index.ejs` |
| `/journal/new` | Render journal entry form | `journal-new.ejs` |
| `/journal/:id` | Render public-entry shell for local hydration | `journal-public.ejs` |

All protected application routes use authentication middleware. Unauthorized full-page requests redirect to `/login`; unauthorized fragment requests return a `401` response that the navigation controller converts into a login redirect.

## Authentication Design

`AuthService` defines the authentication boundary. The initial implementation accepts any non-empty username and passkey, matching the current demo, and writes the minimum operator identity needed to the server session.

The login form submits asynchronously to `POST /auth/login`. After success, the browser runs the existing sequence in this order:

1. Handshake status lines.
2. Decrypting and stream-mounting messages.
3. `ACCESS GRANTED`.
4. Matrix animation.
5. Navigation to `/home`.

Empty credentials produce the existing terminal error without starting the animation. The later Discord OAuth implementation will replace the demo `AuthService` and establish the same session shape. It must not require changes to the cinematic client controller or protected page controllers.

## Navigation and Transition Design

Application links use real `href` values and work without client interception. When JavaScript is available, the navigation controller intercepts eligible same-origin page links.

The sequence is:

```text
click or popstate
  -> show ROUTING / BUFFER transition
  -> request target route as a fragment
  -> controller builds the target view model
  -> EJS renders page content
  -> swap the route container
  -> update title, active navigation, and history
  -> initialize target-page interactions
  -> close transition
```

Only one navigation may commit at a time. A newer navigation cancels or supersedes an older fragment request. The current page stays mounted until a valid response is ready, preventing blank intermediate states. Back and forward navigation use the same fragment pipeline without adding duplicate history entries.

If JavaScript is unavailable or fragment navigation fails before interception, standard server navigation remains functional. Reduced-motion mode shortens the transition while retaining clear route-change feedback.

## Journal Design

The current browser-local journal remains the temporary persistence implementation. Browser-side journal access moves behind a repository contract with operations for listing, finding, creating, and clearing entries. `LocalStorageJournalRepository` uses the existing `synergy-module.journal.v1` local-storage key so existing local records remain readable.

The browser-side `JournalEntry` module owns normalization, default values, and P&L calculation. `JournalService` coordinates creation and lookup through the repository. The journal page controller renders and hydrates local records within the server-rendered page structure.

A later PostgreSQL phase will add an `HttpJournalRepository` in the browser plus HTTP journal endpoints and a PostgreSQL repository on the server. Those pieces will implement the same domain operations. That phase may move validation fully server-side, but must preserve the public view model and interaction contract established here.

## Views and Visual Fidelity

The current application is the accepted reference. The rebuild preserves:

- Existing copy and route hierarchy.
- Near-black green-phosphor palette and OKLCH tokens.
- Share Tech Mono and IBM Plex Mono typography.
- CRT scan lines, vignette, panel borders, spacing, and density.
- ASCII sphere rendering and animation.
- Status ticker and system clock.
- Login handshake, matrix canvas, and access-granted treatment.
- Route glitch/buffer transition and timing.
- Desktop sidebar and sub-880px drawer behavior.
- Focus states and reduced-motion behavior.

The CSS may be reorganized into focused files, but this is not a redesign. Any visual difference discovered during comparison is treated as a regression unless required by semantic markup or accessibility, and such differences must remain visually equivalent.

## Error Handling

- Invalid login input renders the current credential-required message and shake treatment.
- Fragment `401` responses navigate to `/login`.
- Fragment `404` responses keep the current view and show a terminal-style route-not-found toast.
- Network or `5xx` failures keep the current view, close the transition safely, and show a retryable system-error toast.
- Malformed local journal data falls back to an empty collection rather than breaking the route.
- Missing journal records render the existing entry-not-found state.
- Server errors use a production-safe terminal error page and do not expose stack traces.

## Testing Strategy

Unit tests cover journal normalization and P&L calculation, navigation metadata, authentication validation, and repository error handling.

Integration tests cover:

- Full-page and fragment responses for every route.
- Protected-route redirects and fragment `401` behavior.
- Demo login and logout session lifecycle.
- Correct controller/view selection and `404` behavior.

Rendered browser verification covers:

- Login rejection for empty fields.
- Successful handshake, `ACCESS GRANTED`, and matrix animation.
- Seamless navigation across every page with a visible glitch transition.
- Direct-route refresh plus browser back and forward navigation.
- Journal creation, persistence, P&L, list display, and public-entry view.
- Market-news filters, alerts toasts, mobile drawer, logout, and reduced motion.
- Page identity, meaningful content, absence of framework overlays, console health, and screenshot comparison.

Desktop and mobile viewports are compared with the current static reference. Verification must include the login screen, matrix transition, dashboard, at least one route transition, journal flow, and responsive navigation.

## Acceptance Criteria

The rebuild is accepted when:

1. The application runs through an npm development and production start command.
2. Code is organized into explicit model, view, controller, service, repository, route, and public-asset responsibilities.
3. Every application screen has a clean, refreshable server URL.
4. In-app page changes keep the terminal shell mounted and visibly run the glitch/buffer transition.
5. Login preserves the handshake, access-granted, and matrix sequence.
6. Demo authentication is isolated behind a replaceable service suitable for later Discord OAuth.
7. Journal behavior and existing local records remain functional behind a repository boundary suitable for later PostgreSQL work.
8. Direct navigation, fragment navigation, browser history, mobile layout, and reduced motion work without relevant console errors.
9. Automated tests pass and rendered comparison shows no material visual regressions from the existing static application.
