# Workbench

Workbench is split into a Core gateway plus internal domain services.

## Architecture

- External consumers (UI, agent runtimes, future clients) call **Workbench Core only**.
- **Workbench Core** is the single public MCP/tool provider and external HTTP facade.
- `notes`, `artifacts`, `tasks` (and optional `projects`) are internal business services.
- Each service keeps its own database and service-local account table.
- Core delegates to services through internal HTTP clients.

Flow:

`UI / Agent Runtime -> Workbench Core -> Internal Services`

## Auth Model

- User auth is centralized in Core.
- Core issues signed JWT access + refresh tokens on register/login.
- UI stores both tokens, sends `Authorization: Bearer <access token>`, and refreshes access tokens via refresh token.
- Core validates JWT for external API and Core MCP execution.
- Core forwards bearer JWT to internal service business routes.
- Services validate **access** JWT and resolve local account by `core_user_id` (`JWT sub`).
- Tasks service provisions a per-user LBS account/token on `/internal/accounts` and calls LBS with that user token.
- Internal provisioning/admin endpoints (`/internal/accounts`) require `x-api-key`.
- `x-workbench-username` trust model is removed.
- `owner = "system"` fallback on protected CRUD is removed.

## Services

- `services/workbench-core`
  - External HTTP facade
  - External MCP server (`dev:mcp` / `mcp`)
  - User account/auth source of truth
  - Integration config persistence and activation flow
- `services/notes`
  - Internal notes HTTP API
- `services/artifacts`
  - Internal artifacts HTTP API
- `services/tasks`
  - Internal tasks HTTP API
- `services/projects` (optional internal service)
  - Internal projects HTTP API

## Core External Endpoints

- `GET /health`
- `POST /accounts/register`
- `POST /accounts/login`
- `POST /auth/refresh`
- `GET /auth/me`
- `GET /integrations/manifests`
- `GET /integrations/configs`
- `PUT /integrations/configs/:integrationId`

Core facade for domain resources:

- Notes: `/api/notes`, `/api/notes/:id`, `/api/notes/projects`
- Artifacts: `/api/artifacts`, `/api/artifacts/:id`, `/api/artifacts/projects`
- Tasks: `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/history`, `/api/tasks/projects`, `/api/tasks/export`, `/api/tasks/import`

Activation behavior for `PUT /integrations/configs/:integrationId` with `enabled=true`:

- Core tries login using saved values first.
- If login fails, Core auto-registers.
- On success, `accessToken` and optional `refreshToken` are stored in integration config values.

## Internal Service Endpoints

All service routes are internal-facing (called by Core).

Common internal contract:

- `POST /internal/accounts` (requires `x-api-key`, payload `{ coreUserId, username }`)
- Business CRUD routes require bearer JWT and resolve account by `core_user_id`.

## Environment Variables

### Core

- `JWT_SECRET`
- `JWT_ISSUER`
- `JWT_EXPIRY_SECONDS`
- `JWT_REFRESH_EXPIRY_SECONDS` (optional, default: `2592000`)
- `OAUTH_CLIENT_METADATA_HOST_ALLOWLIST` (optional, comma-separated host allowlist for client metadata URL fetches)
- `NOTES_SERVICE_URL`
- `ARTIFACTS_SERVICE_URL`
- `TASKS_SERVICE_URL`
- `PROJECTS_SERVICE_URL` (optional)
- `INTERNAL_API_KEY_NOTES`
- `INTERNAL_API_KEY_ARTIFACTS`
- `INTERNAL_API_KEY_TASKS`
- `INTERNAL_API_KEY_PROJECTS` (optional)

### Services

- `JWT_SECRET`
- `JWT_ISSUER`
- `INTERNAL_API_KEY`
- service-specific DB variables
  - Tasks service additionally uses:
    - `TASKS_LBS_AUTH_BASE_URL`
    - `TASKS_LBS_AUTH_LOGIN_PATH`
    - `TASKS_LBS_AUTH_USER_CREATE_PATH`
    - `TASKS_LBS_ACCOUNT_PASSWORD_SEED`

## UI Config

`ui/.env` requires only:

- `VITE_WORKBENCH_CORE_URL`

UI calls Core endpoints only.

## Scripts

Root scripts:

- `npm run dev`: Core + internal services + web UI
- `npm run dev:services`: Core + internal services (HTTP)
- `npm run dev:gateway:stdio`: Core HTTP + internal services + **Core MCP stdio**
- `npm run dev:mcp`: alias of `dev:gateway:stdio`
- `npm run dev:mcp:stdio`: alias of `dev:gateway:stdio`
- `npm run dev:native:full`: Core + internal services + UI + Tauri

Infra shortcuts:

- `infra/start_services.*`: start backend service stack
- `infra/start_gateway_stdio.*`: start Core MCP gateway + internal services
- `infra/reset_and_bootstrap.*`: reset DB volumes + bootstrap initial account
- `infra/start_web.*`
- `infra/start_native.*`

## Databases

`docker-compose.yml` starts:

- Core DB: `5542`
- Notes DB: `5543`
- Artifacts DB: `5544`
- Tasks DB: `5545`
- Projects DB: `5546`
