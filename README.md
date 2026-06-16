# Workbench

Workbench is split into a Core gateway plus internal domain services.

## Architecture

- External consumers (UI, agent runtimes, future clients) call **Workbench Core only**.
- **Workbench Core** is the single public MCP/tool provider and external HTTP facade.
- `notes`, `artifacts`, `tasks`, `projects`, `images`, and `lbs` are internal business services.
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
- `services/projects`
  - Internal projects HTTP API
- `services/images`
  - Internal image generation HTTP API
- `services/lbs`
  - Local FastAPI LBS backend consumed by Tasks and Core MCP tools

## Core External Endpoints

- `GET /health`
- `POST /accounts/register`
- `POST /accounts/login`
- `POST /auth/refresh`
- `GET /auth/me`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register` (OAuth Dynamic Client Registration for public clients)
- `POST /oauth/token` (OAuth token endpoint: `authorization_code` and `refresh_token` grants)
- `GET /integrations/manifests`
- `GET /integrations/configs`
- `PUT /integrations/configs/:integrationId`

Core facade for domain resources:

- Notes: `/api/notes`, `/api/notes/:id`, `/api/notes/projects`
- Artifacts: `/api/artifacts`, `/api/artifacts/:id`, `/api/artifacts/projects`
- Tasks: `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/history`, `/api/tasks/projects`, `/api/tasks/export`, `/api/tasks/import`
- Images: `/api/images/defaults`, `/api/images/references`, `/api/images/generations`, `/api/images/assets/:id/download`

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

Workbench keeps port and local URL settings in one canonical file:

- `infra/workbench.env`

`infra/initialize_system.*` creates this file from `infra/workbench.env.example` and synchronizes derived values into service `.env` files. Edit `infra/workbench.env` when changing local ports, hosts, `LBS_API_PREFIX`, or the UI dev port, then run:

```bash
node infra/scripts/workbench-env.mjs sync
node infra/scripts/workbench-env.mjs check
```

Service `.env` files should keep secrets and DB credentials. Values such as `LBS_SERVICE_URL`, `TASKS_LBS_BASE_URL`, service ports, and `VITE_WORKBENCH_CORE_URL` are generated from `infra/workbench.env`.

### Core

- `CORE_SERVICE_HOST` (for remote deployment, use `0.0.0.0`)
- `CORE_SERVICE_PORT`
- `CORE_EXTERNAL_BASE_URL` (recommended for remote MCP/OAuth behind proxies/tunnels; must be public HTTPS base URL)
- `JWT_SECRET`
- `JWT_ISSUER`
- `JWT_EXPIRY_SECONDS`
- `OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS` (optional, default: `2592000`)
- `JWT_REFRESH_EXPIRY_SECONDS` (optional, default: `2592000`)
- `OAUTH_CLIENT_METADATA_HOST_ALLOWLIST` (optional, comma-separated host allowlist for client metadata URL fetches)
- `NOTES_SERVICE_URL`
- `ARTIFACTS_SERVICE_URL`
- `TASKS_SERVICE_URL`
- `PROJECTS_SERVICE_URL` (optional)
- `IMAGES_SERVICE_URL`
- `LBS_SERVICE_URL`
- `INTERNAL_API_KEY_NOTES`
- `INTERNAL_API_KEY_ARTIFACTS`
- `INTERNAL_API_KEY_TASKS`
- `INTERNAL_API_KEY_PROJECTS` (optional)
- `INTERNAL_API_KEY_IMAGES`
- `WORKBENCH_CORE_MUTATION_TOKEN` (optional, sent to domain services with Core-origin mutations)

### Services

- `JWT_SECRET`
- `JWT_ISSUER`
- `INTERNAL_API_KEY`
- `WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN` (optional, set `true` to reject direct user-facing mutations outside Core)
- `WORKBENCH_CORE_MUTATION_TOKEN` (optional, must match Core when the mutation-origin guard is enabled)
- service-specific DB variables
  - Tasks service additionally uses:
    - `TASKS_LBS_BASE_URL`
    - `TASKS_LBS_AUTH_BASE_URL`
    - `TASKS_LBS_AUTH_LOGIN_PATH`
    - `TASKS_LBS_AUTH_USER_CREATE_PATH`
    - `TASKS_LBS_ACCOUNT_PASSWORD_SEED`

## UI Config

`ui/.env` requires only:

- `VITE_WORKBENCH_CORE_URL`

UI calls Core endpoints only.

For remote MCP connector setups, configure `CORE_EXTERNAL_BASE_URL` to the exact externally reachable HTTPS origin (or base path) used by clients so OAuth issuer/resource metadata and MCP token audience validation remain consistent.

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

Config helpers:

- `node infra/scripts/workbench-env.mjs sync`: synchronize runtime `.env` files from `infra/workbench.env`
- `node infra/scripts/workbench-env.mjs check`: fail if runtime `.env` files drift from `infra/workbench.env`
- `node infra/scripts/workbench-env.mjs ports [--ui|--only-ui]`: print configured ports for launch scripts

## Public Web Serving

For a public web entrypoint, build the UI and expose Workbench Core only. Core serves `ui/dist` when it exists, while API, OAuth, and MCP routes remain on the same origin.

1. Confirm canonical local settings:

   ```bash
   cat infra/workbench.env
   node infra/scripts/workbench-env.mjs check
   ```

2. Build the web UI:

   ```bash
   npm run build --workspace ui
   ```

3. Start backend services:

   ```bash
   bash infra/start_services.sh
   ```

4. Publish only the Core port from `infra/workbench.env`:

   ```text
   http://127.0.0.1:4100
   ```

5. Open the tunnel URL in a browser. The built UI uses the current browser origin as its Core URL when served by Core, so a separate `5174` tunnel is not needed.

For stable remote OAuth or MCP clients, set `CORE_EXTERNAL_BASE_URL` in `services/workbench-core/.env` to the public HTTPS tunnel origin and restart Core. For browser-only use behind a tunnel that forwards `x-forwarded-proto` and `x-forwarded-host`, Core can derive the issuer from request headers.

## Databases

`docker-compose.yml` starts:

- Core DB: `5542`
- Notes DB: `5543`
- Artifacts DB: `5544`
- Tasks DB: `5545`
- Projects DB: `5546`
- Images DB: `5547`

LBS defaults to local sqlite for development when `services/lbs/.env` does not set `DATABASE_URL`.
