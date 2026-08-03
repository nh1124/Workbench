# Workbench

Workbench is a Core gateway backed by internal domain services. External clients use Core; each domain service owns its data and database.

## Architecture

- External consumers such as the UI and agent runtimes call **Workbench Core only**.
- **Workbench Core** is the single public MCP/tool provider and external HTTP facade.
- `notes`, `artifacts`, `tasks`, `projects`, `images`, `mindmaps`, `wbs`, and `analyser` are internal services.
- Core delegates to internal services over HTTP and provisions service-local accounts where required.
- Analyser stores collection policy, metadata-only observations and resource references, server-side routine schedules and cursors, summaries, proposals, operation audit records, and publication dedupe records. Existing domain services still own and perform resource mutations.

```text
UI / Agent Runtime -> Workbench Core -> Internal Services
                                      -> Analyser
```

## Auth model

- User auth is centralized in Core.
- Core issues signed JWT access and refresh tokens on register/login.
- The UI sends `Authorization: Bearer <access token>` and refreshes expired access tokens.
- Refresh tokens are held differently per client, so page script never has one to leak:
  - **Browser**: Core sets the refresh token as an `HttpOnly; SameSite=Lax; Path=/auth` cookie
    (`Secure` whenever the request arrived over HTTPS, including via `x-forwarded-proto`). Nothing is
    written to `localStorage`; the access token stays in memory and a reload restores the session by
    spending the cookie once against `POST /auth/refresh`.
  - **Native (Tauri)**: unchanged — the session lives in OS secure storage and the refresh token is
    sent in the request body.
  - `POST /auth/refresh` accepts either source, preferring the cookie, and drops a cookie it rejects.
- The browser flow assumes the UI is served from Core's origin, which is how production runs
  (Core serves `ui/dist`). For dev, Vite proxies Core's routes so the same origin holds — point
  `VITE_WORKBENCH_CORE_URL` at the Vite dev server, and set `VITE_WORKBENCH_CORE_PROXY_TARGET` if
  Core is not on `http://127.0.0.1:4100`. Pointing `VITE_WORKBENCH_CORE_URL` straight at Core still
  works, but the browser session will not survive a reload.
- Core validates JWTs for the external API and Core MCP execution, then forwards the bearer JWT to internal business routes.
- Internal provisioning endpoints use `x-api-key`.
- Tasks is the provisioning exception: it uses the JWT `sub` as its local owner identity and has no `/internal/accounts` route.
- `x-workbench-username` trust and the `owner = "system"` fallback are not used.

## Services and default ports

| Workspace | Default HTTP port | Responsibility |
|---|---:|---|
| `services/workbench-core` | 4100 | Public HTTP facade, MCP server, auth, service provisioning, integration configuration, analyser projection |
| `services/notes` | 4101 | Notes API |
| `services/artifacts` | 4102 | Artifact tree, content, files, and Project memberships |
| `services/tasks` | 4103 | Tasks API and local TypeScript/PostgreSQL LBS engine |
| `services/projects` | 4104 | Projects, brief, memory, relations, links, and index |
| `services/images` | 4105 | Image generation jobs and assets |
| `services/mindmaps` | 4106 | Mind-map documents |
| `services/wbs` | 4107 | WBS plans |
| `services/analyser` | 4109 | Collection policy, observations, routine state, summaries, proposals, operations, and publications |

Core facade route prefixes include `/api/notes`, `/api/artifacts`, `/api/tasks`, `/api/projects`, `/api/images`, `/api/mindmaps`, `/api/wbs`, and `/api/analyser`. Analyser's direct `/health` and business routes are internal; clients use the Core `/api/analyser/*` facade or the `analyser.*` MCP tools.

### `native/sync-daemon` is not one of these

It is not a server at all. It is built into an executable (`npm run sidecar:build`), shipped
inside the desktop app as a Tauri sidecar, and runs on the user's own machine bound to
`127.0.0.1` — one per device. It is absent from `docker-compose.yml` and from `npm run dev`
for that reason, and it has no port in the table above because nothing outside the machine
may reach it.

It lived under `services/` until 2026-08-03 and was moved to `native/` precisely because that
placement kept suggesting it was a deployable service.

Anything about its lifetime — how many apps depend on it, whether it exits when they all
close — is therefore per-device state that lives in the daemon process itself, not on a
server. See `docs/imple/workbench-native-variant-apps-plan.md`, "Phase 4".

## Analyser routine contract

Analyser seeds these owner-scoped routines idempotently in the `Asia/Tokyo` timezone:

- `daily-work-summary`
- `progress-record-maintenance`
- `artifact-classification`
- `workbench-knowledge-maintenance`
- `weekly-workbench-digest`
- `agent-skills-materialization`

Schedule configuration, `nextRunAt`, committed observation cursors, active runs, leases, retry counts, and backoff state live server-side only. An external agent polls coarsely and calls `analyser.routines.claim`; `{ "claim": null }` means there is no due work.

A claimed run heartbeats before its lease expires, repeatedly pulls metadata-only observations, resolves only necessary resource bodies through existing Core tools, and writes summaries or proposals. A direct resource operation is allowed only for a high-confidence, policy-allowlisted kind and is performed by the owning domain tool, verified by re-read, then recorded with `analyser.operations.record`. Completing a run commits its pending cursor; failing a run leaves the committed cursor unchanged so observations can be retried.

Agents may create proposals but cannot approve/reject them or change collection settings. Those actions use the authenticated Analyser UI. Agent-side exports to Notes or Artifacts are deduplicated through `analyser.publications.record`.

## Core external endpoints

- `GET /health`
- `POST /accounts/register`
- `POST /accounts/login`
- `POST /auth/refresh`
- `POST /auth/logout` (clears the browser refresh cookie)
- `GET /auth/me`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `POST /oauth/token`
- `GET /integrations/manifests`
- `GET /integrations/configs`
- `PUT /integrations/configs/:integrationId`

Activation with `PUT /integrations/configs/:integrationId` and `enabled=true` tries login with saved values first, auto-registers if login fails, and stores the resulting access token plus any refresh token.

## Internal service contract

Internal service routes are called by Core:

- `POST /internal/accounts` requires `x-api-key` and `{ coreUserId, username }`.
- Business routes require a bearer JWT and resolve the account by `core_user_id`.
- Tasks scopes directly by the bearer JWT owner and does not expose `/internal/accounts`.

## Environment variables

The canonical local port and URL file is `infra/workbench.env`. `infra/initialize_system.*` creates it from `infra/workbench.env.example`, and the environment helper synchronizes derived values into service `.env` files:

```bash
node infra/scripts/workbench-env.mjs sync
node infra/scripts/workbench-env.mjs check
```

Edit `infra/workbench.env` when changing hosts or ports. Keep secrets and database credentials in service `.env` files.

### Core

- `CORE_SERVICE_HOST`, `CORE_SERVICE_PORT`, `CORE_EXTERNAL_BASE_URL`
- `JWT_SECRET`, `JWT_ISSUER`, `JWT_EXPIRY_SECONDS`
- `OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS`, `OAUTH_CLIENT_METADATA_HOST_ALLOWLIST`
- `NOTES_SERVICE_URL`, `ARTIFACTS_SERVICE_URL`, `TASKS_SERVICE_URL`
- `PROJECTS_SERVICE_URL`, `IMAGES_SERVICE_URL`, `MINDMAPS_SERVICE_URL`, `WBS_SERVICE_URL`
- `ANALYSER_SERVICE_URL` (default local URL `http://127.0.0.1:4109`)
- matching `INTERNAL_API_KEY_*` values, including `INTERNAL_API_KEY_ANALYSER`
- `WORKBENCH_CORE_MUTATION_TOKEN` when the Core-origin guard is enabled
- `INTERNAL_SERVICE_TIMEOUT_MS` (default `30000`) bounds every internal service call; timeouts surface as HTTP 504

### Analyser

- `ANALYSER_SERVICE_HOST`, `ANALYSER_SERVICE_PORT`
- `ANALYSER_DB_HOST`, `ANALYSER_DB_PORT`, `ANALYSER_DB_NAME`, `ANALYSER_DB_USER`, `ANALYSER_DB_PASSWORD`
- `JWT_SECRET`, `JWT_ISSUER`
- `INTERNAL_API_KEY_ANALYSER`

### Shared service options

- `JWT_SECRET`, `JWT_ISSUER`, `INTERNAL_API_KEY`
- `WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN`, `WORKBENCH_CORE_MUTATION_TOKEN`
- service-specific database variables
- Tasks additionally uses `TASKS_LBS_MODE=local` and `TASKS_TIMEZONE`
- Logging (`@workbench/logging`): `LOG_LEVEL`, `WORKBENCH_LOG_DIR`, `WORKBENCH_LOG_CONSOLE=0` to silence
  the console mirror, and `WORKBENCH_LOG_RETENTION_DAYS` (default `14`). Each service writes
  `logs/<service>-<date>.jsonl` and sweeps files past the retention window once a day, so `logs/` does
  not need manual pruning.

The UI needs only `VITE_WORKBENCH_CORE_URL`. For remote MCP or OAuth clients, set `CORE_EXTERNAL_BASE_URL` to the exact externally reachable HTTPS origin or base path.

## Launch

Root scripts include Analyser:

- `npm run dev`: Core, all internal services, and the web UI
- `npm run dev:services`: Core and all internal HTTP services
- `npm run dev:gateway:stdio`: Core HTTP, internal services, and Core MCP over stdio
- `npm run dev:mcp`: alias of `dev:gateway:stdio`
- `npm run dev:mcp:stdio`: alias of `dev:gateway:stdio`
- `npm run dev:native:full`: Core, internal services, UI, and Tauri

Infra shortcuts:

- `infra/start_services.*`: initialize/check configuration, start database containers plus the Dockerized Artifacts service, then run the other HTTP services locally
- `infra/start_gateway_stdio.*`: start the Core MCP gateway and internal services
- `infra/reset_and_bootstrap.*`: reset database volumes and bootstrap the initial account
- `infra/start_web.*`
- `infra/start_native.*`

To start only the Analyser database and service during development:

```bash
docker compose up -d analyser-db
npm run dev:http --workspace services/analyser
```

## Public web serving

Core serves `ui/dist` when it exists, keeping the UI, API, OAuth, and MCP routes on one origin.

1. Check canonical settings with `node infra/scripts/workbench-env.mjs check`.
2. Build the UI with `npm run build --workspace ui`.
3. Start services with `infra/start_services.*`.
4. Publish only the configured Core port (default `4100`).

The built UI uses the browser origin as its Core URL. For stable remote OAuth or MCP clients, set `CORE_EXTERNAL_BASE_URL` and restart Core.

## Databases

The root `docker-compose.yml` defines these PostgreSQL services and host ports (the Cloudflare tunnel
is a separate stack in `infra/docker-compose.edge.yml`):

| Compose service | Container | Host port | Database | Volume |
|---|---|---:|---|---|
| `workbench-core-db` | `workbench-core-db` | 5542 | `workbench_core_db` | `workbench_core_pgdata` |
| `notes-db` | `workbench-notes-db` | 5543 | `notes_db` | `notes_pgdata` |
| `artifacts-db` | `workbench-artifacts-db` | 5544 | `artifacts_db` | `artifacts_pgdata` |
| `tasks-db` | `workbench-tasks-db` | 5545 | `tasks_db` | `tasks_pgdata` |
| `projects-db` | `workbench-projects-db` | 5546 | `projects_db` | `projects_pgdata` |
| `images-db` | `workbench-images-db` | 5547 | `images_db` | `images_pgdata` |
| `mindmaps-db` | `workbench-mindmaps-db` | 5548 | `mindmaps_db` | `mindmaps_pgdata` |
| `wbs-db` | `workbench-wbs-db` | 5549 | `wbs_db` | `wbs_pgdata` |
| `analyser-db` | `workbench-analyser-db` | 5551 | `analyser_db` | `analyser_pgdata` |

See `docs/imple/workbench-analyser-operations-runbook.md` for settings, routine triage, retention, backup/restore, and log procedures.
