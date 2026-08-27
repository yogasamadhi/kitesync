# AGENTS.md

KiteSync: server-centric LAN file sync product (Syncthing data plane + Fastify/PostgreSQL control plane). Bun-managed monorepo (`apps/*`, `packages/*`, `services/*`). Docs and UI strings are written in Chinese (zh-CN); keep new user-facing text Chinese to match.

## Toolchain & setup

- Bun 1.4+ is required for workspace/scripts/dev, but Node.js 24 is the production runtime (`apps/control-plane`, `services/*` run under `node`, not bun).
- Fresh clone: `bun run bootstrap` (frozen install → dev CA certs → verify Syncthing v2.1.3 release). Run `bun run dev:all` to launch everything.
- Dev certs are generated into `deploy/compose/certs/` and are gitignored; control-plane `config.ts` defaults mTLS client certs to that path, and compose mounts it into hub-agent. Generate with `bun run dev:certs` if containers fail on certs.
- No .env auto-loading anywhere. Apps have baked-in dev defaults (see `apps/control-plane/src/config.ts`, `.env.example` for overrides). Do not add dotenv.

## Commands

- `bun run check` = prettier check → eslint → `scripts/check-boundaries.mjs` → migration checksums → typecheck → vitest unit tests (no Docker needed). Run this whole command, not pieces: each step is cheap and catches different things.
- `bun run test:integration` — Testcontainers PostgreSQL 17, requires Docker daemon.
- `bun run test:e2e` — Playwright for Web only; its webserver is just `vite dev` for `apps/web`, which resolves `@kitesync/ui`/`@kitesync/api-client`/`@kitesync/contracts` from their built `dist`. Run `bun run predev` (or a prior `dev`/`build`) first, or routes/imports fail with missing dist.
- `bun run dev` (host apps only, deps must be up), `bun run dev:deps` (compose + migrations), `bun run dev:stop` / `dev:reset` (stop/reset + delete dev data; reset asks for confirmation).
- `run.ts` flags: `--headless`, `--no-deps`, `--keep-deps`, `--inspect`. Ctrl+C stops only containers it started (checks `docker compose ps` first).
- Dev admin is auto-created by run.ts (admin / kitesync-development, overridable via `KITESYNC_DEV_*`); never modified if DB already bootstrapped.
- Helm lint (and CI) requires explicit `--set` values: `controlPlane.bootstrapToken`, `controlPlane.cookieSecret`, `hub.apiKey`, `postgresql.password`, `backup.enabled=false`. Local PRs don't run Kind; nightly/release do (see `deploy/helm/kitesync`, `scripts/`).

## Architecture notes

- `apps/control-plane` (Fastify + TypeBox + Drizzle): business source of truth; routes use `@kitesync/contracts` TypeBox schemas. Recipes: `scripts/generate-openapi.mjs` regenerates `packages/api-client/openapi.json` from a live control plane (needs one running at `127.0.0.1:3000`).
- `apps/web` (React/Vite/TSR) and `apps/desktop` renderer communicate only via contracts — never import server-side modules.
- `services/hub-agent` runs inside compose with `network_mode: service:syncthing-hub`; it's the only process holding the Syncthing API key; Syncthing REST stays internal (`127.0.0.1:8384`), mTLS contract exposed on `127.0.0.1:9443`.
- `packages/{contracts,ui,api-client}` are consumed via their `dist` builds, not `src` — after editing them, rebuild (`bun run predev` or their `dev` watch task). The root `dev` script runs their watch mode, so dist stays fresh during normal dev.

## Gotchas

- `apps/control-plane/migrations/*.sql` are immutable; `scripts/check-migration-checksums.mjs` hashes against `checksums.sha256`. To add a migration: new numbered `.sql`, regenerate `checksums.sha256` manually (no script exists), and add its filename to the hardcoded list in `tests/integration/migrations.test.ts`. Never edit an existing migration.
- `scripts/check-boundaries.mjs` enforces import rules (web renderer: no drizzle/node/electron; desktop renderer: no node/electron/desktop-runtime source; control-plane: no desktop/hub-agent source). ESLint won't catch these — it's only wired into `bun run check`, not `lint` alone.
- `bun run typecheck` at root first typechecks `run.ts` (`tsconfig.scripts.json`), then each workspace. Individual workspace typecheck doesn't cover `run.ts`.
- Desktop packaging (`apps/desktop/build`) bundles `vendor/syncthing/bin/<platform>-<arch>` and a runtime from `apps/desktop-runtime/dist`; Syncthing binary must be present (`bun run syncthing:verify` prefetch via `KITESYNC_SYNCTHING_PLATFORM`/`KITESYNC_SYNCTHING_ARCH`).
- Electron preload must stay CommonJS (`.cts`); the ESLint override for `apps/desktop/src/main/**/*.cts` exists on purpose.
- Safety invariants baked into product: no discovery/relay/P2P for clients, writable-only config; desktop treats `StorageUnavailable` as a state, not file deletion.

## Docs

Guides: `docs/operations/DEVELOPMENT.md`, `docs/operations/PRODUCTION_RUNBOOK.md`, `docs/operations/BACKUP_RESTORE.md`, `docs/operations/RELEASE.md`. Architecture: `docs/architecture/KITESYNC_SERVER_CENTRIC_ARCHITECTURE.md`, `docs/architecture/desktop/*`.
