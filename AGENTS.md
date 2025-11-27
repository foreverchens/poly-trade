# Repository Guidelines

## Project Structure & Module Organization
Runtime code sits in `src/icu/poly`: `core/` houses the Polymarket client helpers, `view/` exposes the static dashboard, and `web-server.js` wires REST endpoints with the asset bundle. Automated agents (`auto-maker-bot.js`, `endgame-bot.js`) reuse the same client utilities, so keep shared logic in `core/` to avoid drift. Tests mirror this map under `test/icu/poly`, with one `*.test.js` per `PolyClient` method and reusable fixtures in `test-helper.js`. Front-end HTML/CSS/JS must stay inside `src/icu/poly/view` so `express.static` picks them up without extra routing.

## Build, Test, and Development Commands
Run `npm install` once per checkout to hydrate dependencies. Use `npm start` to launch `src/icu/poly/web-server.js`, which serves `/api/*` JSON alongside the dashboard bundle. `npm test` executes every Node test via the built-in runner, while `npm run test:single -- "name" test/icu/poly/get-order-book.test.js` narrows focus for fast iteration. Capture logs in `logs/` when debugging agents; the scripts already write there.

## Coding Style & Naming Conventions
The repo is strictly ESM—stick with `.js` modules that use `import`/`export`. Apply four-space indentation, keep trailing commas on multi-line literals, and prefix constants descriptively (`DEFAULT_`, `SUPPORTED_`). Guard env-sensitive paths near the top of each module (e.g., `if (!process.env.PRIVATE_KEY) throw new Error(...)`). API routes use kebab-case paths (`/api/place-order`) and handler names that describe side effects.

## Testing Guidelines
Tests rely on the Node test runner plus lightweight network stubs. Name files after the method under test (`get-order-book.test.js`) and isolate each `test("does X")` block—no shared mutable state. Extend `test-helper.js` when a fixture or mock is needed, rather than duplicating setup in specs. Cover null params, unsupported intervals, and HTTP error payloads so the REST layer remains predictable, especially for bot consumers.

## Commit & Pull Request Guidelines
History favors short, lowercase subjects (e.g., `add orderbook cache`); keep them imperative and reference issue IDs where applicable. PRs should summarize scope, enumerate touched endpoints or bots, list new env vars, and include screenshots for UI updates. Always mention `.env` expectations so reviewers can reproduce. Call out manual steps (e.g., seeding markets) in the PR body.

## Security & Configuration Tips
All agents and the web server require `PRIVATE_KEY` plus any host overrides defined in `.env`; never commit secrets. Document non-default hosts both in code comments and PR notes so other operators remain in sync. When redirecting traffic or enabling new bots, review `logs/` and add alerts or TODOs where unexpected failures could leak keys.
