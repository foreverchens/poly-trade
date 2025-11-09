# Repository Guidelines

## Project Structure & Module Organization
- Runtime code lives under `src/icu/poly`: `core/` holds the Polymarket client, `view/` contains the static dashboard, and `web-server.js` exposes REST + static routes. Automated agents (`auto-maker-bot.js`, `endgame-bot.js`) reuse the same helpers.  
- Tests mirror this layout in `test/icu/poly`, with one `*.test.js` per `PolyClient` method and shared fixtures in `test-helper.js`; colocate new code and tests to preserve the mapping.  
- Keep HTML/CSS/JS assets in `src/icu/poly/view` so `express.static` can serve them without extra config.

## Build, Test, and Development Commands
- `npm install` – restore dependencies before running anything.  
- `npm start` – boot `src/icu/poly/web-server.js`, which serves `/api/*` JSON plus the crypto-market UI.  
- `npm test` – execute every `test/**/*.test.js` via the Node test runner.  
- `npm run test:single -- "name" path/to/file.test.js` – narrow execution to a single spec or file while iterating.

## Coding Style & Naming Conventions
- Native ES modules are required (`type: "module"`); stick with `.js` files that use `import`/`export`.  
- Follow the prevailing four-space indent, trailing commas for multi-line literals, and descriptive constant prefixes (`DEFAULT_*`, `SUPPORTED_*`).  
- Place env-sensitive logic (e.g., `PRIVATE_KEY` checks) near the top of each module and fail fast with explicit errors.  
- Add HTTP routes using kebab-case paths (`/api/place-order`) and descriptive handler names.

## Testing Guidelines
- Tests rely on the built-in Node runner with lightweight network stubs; extend `test-helper.js` for new fixtures instead of duplicating setup.  
- Name specs after the method under test (`get-order-book.test.js`) and keep `test("does X")` blocks isolated—no shared mutable state.  
- Cover edge cases such as null parameters, unsupported intervals, and HTTP error payloads so the REST layer stays predictable.

## Commit & Pull Request Guidelines
- Recent history favors terse, lower-case subjects (e.g., `test`, `1`); follow the pattern with short imperative phrases (`add orderbook cache`) plus issue IDs when relevant.  
- PRs should summarize scope, list touched endpoints, call out new env vars (e.g., `PRIVATE_KEY`), and include screenshots for UI changes.  
- Always mention `.env` expectations in the PR body so reviewers can recreate the setup locally.

## Security & Configuration Tips
- The bots and server require `PRIVATE_KEY` (plus any Polymarket host overrides) in your local `.env`; never commit secrets.  
- If you redirect the client to alternate hosts, document the new URLs inside code comments and in the PR so other agents stay in sync.
