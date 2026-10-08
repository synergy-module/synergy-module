# Synergy Module / Redline Cortex UI

The interface on `dev` adapts the user-supplied `tests/redline-cortex.zip`. The original archive stays local; the required design tokens, artwork and adapted renderer are committed as ordinary application assets. The application remains EJS and browser JavaScript.

## Design mapping

| Reference element | Synergy Module implementation |
| --- | --- |
| Core and Daylight tokens | `public/css/redline-tokens.css`; shared aliases and shell in `redline.css` |
| Chakra Petch / IBM Plex Sans / JetBrains Mono | Display headings / reading text / numerical and technical values |
| Flat panels with red corner brackets | Reusable Cortex panels across research, journal, calendar and administration |
| MatrixBrain | Seeded 3,400-glyph branching neural network, eight interactive regions, rotation, movement and zoom |
| AgentRoster / AgentDetail / ActivityStream | Four actual agent roles and four support regions; detail appears only after selection |
| KPI tiles and market cards | Saved mission usage lives in Research; equal stocks/options/crypto entry points live in Accounts |
| Cover art | Supplied block-and-binary SVG adapted for Discord sign-in |

The source demo's account balances, performance charts, eight simulated agents, random market values and pretend connection flows are not application data. Those demos are replaced by existing server state and honest empty states. Synergy Module is the product name. The app's persistent navigation and real forms are retained.

## Behavior

- Core is the default. Daylight is a user preference stored under `synergy-module-theme`; earlier installations retain their selection through the legacy-key migration. It contains no account information. The canvas updates when the theme changes.
- Brain animation is decorative and uses no model tokens. Its orientation stays fixed until you rotate it; individual binary glyphs shift, flicker and brighten in sporadic bursts. It runs at a capped 30 fps, stops when hidden, supports manual pause and reduced motion, and disposes its observers and handlers when leaving the route.
- Region controls remain keyboard accessible without canvas support. Arrow keys rotate; Shift-arrow keys move the view. The camera survives in-app navigation and resets on refresh.
- Smaller screens use a navigation drawer and a full neural canvas. Selecting a region opens a dismissible detail panel. Connections and defaults live in Settings; missions and knowledge live in Research.
- Discord authentication, capability filtering, paid-AI settings, broker submission locks, exact-action review, CSRF and owner isolation remain enforced by the existing server.
- The Brain state endpoint adds an explicit projection of broker connection switches and storage status. It does not expose tokens, account snapshots or broker action payloads to the decorative renderer.

Assets use the existing content-hashed manifest. Restart the application after deploying changed assets so it serves the new asset version. See [workspace setup](workspace-setup.md) for persistent sessions, encrypted user credentials, and migration 005.
