# Local Development (Floci offline emulation)

Single-command, fully-offline local stack for the **V2 API** + the **groov-db-ui**
frontend. The AWS backend (API Gateway v2, Lambda, Cognito, DynamoDB, S3) is
emulated by [Floci](https://floci.io) — a free, LocalStack-community-compatible
drop-in — with **real Lambda containers** whose code is **hot-reloaded** straight
from `functions/`. The UI runs `react-scripts start` with Fast Refresh.

> **Local is V2-only and Python-only.** V1 / Node functions are not provisioned
> locally. Production is unaffected: `template.yaml` (SAM) and the real AWS
> deploy are untouched by anything here.

---

## Cheat sheet

```bash
# from the groov-db-api repo root:
docker compose up                      # start everything (add -d to detach)
docker compose down                    # stop (keeps data volumes)
docker compose down -v && docker compose up   # CANONICAL clean re-standup (see §9)

docker compose logs -f floci           # Floci (AWS emulator) logs
docker compose logs -f floci-init      # one-shot provisioner (prints the summary)
docker compose logs -f ui              # CRA dev server logs
docker compose build ui                # rebuild UI image after a dependency change
```

| | URL |
|---|---|
| UI | http://localhost:3000 |
| Floci (AWS endpoint) | http://localhost:4566 |
| V2 API base | `http://localhost:4566/execute-api/<API_ID>/dev` (API_ID is per-run — see §5) |

**Log in (local):** open http://localhost:3000, click **Sign In**. It logs you in
as the seeded admin automatically — no AWS, no hosted UI.
Seeded admin: **`admin@groov.local` / `GroovLocal1!`** (group `Admin`).

---

## 1. Overview

`docker compose up` brings up three services:

- **`floci`** — the AWS emulator on `:4566`. Emulates API Gateway v2 (HTTP API),
  Lambda (real containers, spawned on the host Docker via the mounted
  `docker.sock`), Cognito, DynamoDB, and S3. Lambda **hot-reload** is enabled:
  each function's source dir is bind-mounted into its container, so editing a
  handler `.py` takes effect on the next invocation — no rebuild, no redeploy.
- **`floci-init`** — a one-shot provisioner (`floci/provision.sh`) that creates
  the DynamoDB tables, S3 buckets + seed data, Cognito pool/client/group/user,
  the shared Lambda layers, the 12 V2 Lambda functions + the ported Python
  authorizer + `updateFingerprintV2`, and the HTTP API (routes + authorizers +
  `dev` stage). It then writes the per-run dynamic values (API id, Cognito
  ids) to `/shared/ui.env` for the UI, prints a summary, and exits 0.
- **`ui`** — the `groov-db-ui` CRA dev server on `:3000`, hot-reloading via Fast
  Refresh. Its entrypoint sources `/shared/ui.env` before starting, so it picks
  up the dynamic API/Cognito values from `floci-init`.

The "API" is not a long-running service — it is the set of Lambdas that Floci
runs on demand, hot-reloading from `functions/`. That is what makes this a true
emulation rather than a mock.

## 2. Prerequisites

- **Docker Desktop running.** Floci mounts `/var/run/docker.sock` to spawn the
  real Lambda containers on your host Docker daemon, so the daemon must be up
  before `docker compose up`.
- **Apple Silicon / arm64 host.** The stack is built for arm64: Lambda functions
  are created with `--architectures arm64`, and the `rdkit` layer ships aarch64
  `manylinux` wheels (`layers/rdkit/`). On an x86_64 host you would need to
  rebuild that layer for x86_64 (see `layers/rdkit/build.sh`).
- **First run is slow (roughly ~5–10 min, approximate):** Docker pulls the Floci
  image, `npm ci` builds the UI image, and the first invocation of each Lambda
  pulls its AWS base image (`public.ecr.aws/lambda/python:3.12` / `3.13`) and
  cold-starts a container. Subsequent runs are much faster. Expect a few GB of
  disk for the images + layers.
- No AWS account or credentials needed — Floci accepts the dummy creds
  (`test`/`test`) the stack already sets.

## 3. Layout & repos

The compose file lives in **`groov-db-api`** and builds/bind-mounts
**`../groov-db-ui`**. The two repos **must be siblings**:

```
<parent>/
├── groov-db-api/   ← docker-compose.yml, floci/provision.sh, functions/  (run `docker compose up` HERE)
└── groov-db-ui/    ← Dockerfile, docker-entrypoint.sh, src/
```

Branches used for local dev:

| Repo | Branch |
|---|---|
| groov-db-api | `local_dev_improvements` |
| groov-db-ui | `local-dev-improvements` |

`floci-init` derives each Lambda's hot-reload host path from `${PWD}`
(`HOST_API_DIR`), so you **must run `docker compose up` from the `groov-db-api`
repo root**.

## 4. Quick start

```bash
cd <parent>/groov-db-api
docker compose up            # -d to run detached
```

Startup order (enforced by compose):

1. `floci` starts and becomes healthy (`/_localstack/health`).
2. `floci-init` runs `floci/provision.sh`, provisions everything, writes
   `/shared/ui.env`, prints a summary, and **exits 0**.
3. `ui` waits for `floci-init` to complete (`service_completed_successfully`),
   sources `/shared/ui.env`, and starts CRA.

**How to know it's ready:**

- `docker compose logs floci-init` ends with
  `groov-db-api local (Floci) provisioning complete` and a summary block
  (API base, Cognito ids, seeded admin, static bucket).
- `docker compose logs ui` shows `Compiled successfully` and the app answers on
  http://localhost:3000.

## 5. URLs, ports & the dynamic API id

- **UI:** http://localhost:3000
- **Floci (AWS endpoint):** http://localhost:4566
- **V2 API invoke pattern:** `http://localhost:4566/execute-api/<API_ID>/dev/<route>`
  — e.g. `http://localhost:4566/execute-api/<API_ID>/dev/v2/insertForm`.

`<API_ID>` is **generated fresh on every provisioning run** (Floci does not
support a fixed/custom id). You normally never need it by hand — the UI reads it
automatically. To find it:

```bash
# from the provisioner summary:
docker compose logs floci-init | grep "API base"

# or straight from the shared env file the UI consumes:
docker run --rm -v groov-db-api_floci_shared:/s alpine cat /s/ui.env
```

## 6. Auth (local)

Floci does **not** emulate the Cognito Hosted UI / OAuth redirect flow, so local
dev uses a small **client-side auth shim** in `src/utils/auth.js`, gated entirely
behind `REACT_APP_LOCAL_AUTH`.

- With `REACT_APP_LOCAL_AUTH=true` (set in the UI's committed `.env.development`):
  clicking **Sign In** calls Cognito `InitiateAuth` (`USER_PASSWORD_AUTH`)
  directly against the local pool (`REACT_APP_COGNITO_ENDPOINT`,
  `http://localhost:4566`) using the baked seeded-admin creds, stores the
  returned tokens, and attaches the **ID token** as the raw `Authorization`
  header on V2 API calls (byte-identical to prod, so the server path is
  unchanged).
- **Seeded admin (the single source of truth, set in `floci/provision.sh`):**
  **`admin@groov.local` / `GroovLocal1!`**, group **`Admin`**.
- With the flag **unset** (every real/prod build), none of the shim runs — the
  app uses the unchanged Amplify `federatedSignIn()` Hosted-UI path exactly as
  before.

The server side is faithful: the ported **Python** authorizer
(`functions/adminAuthorizer/adminAuthorizer.py`) verifies the JWT's RS256
signature against Floci's JWKS and checks the `Admin` group — the same way prod
verifies against real Cognito's JWKS.

## 7. Hot reload

**API (Lambda) — edit `functions/*V2/*.py`, changes are live on the next call.**
No restart, no redeploy (Floci bind-mounts each function's source dir into its
container).

```bash
# prove it: add a marker header to a handler's response, then re-invoke.
# e.g. in functions/getAllTempSensorsV2/getAllTempSensors.py, add a header to a
# return dict, save, and call the route again — the new header appears
# immediately with no `docker` command in between.
```

**UI — edit `src/**`, the browser Fast-Refreshes.** Polling is enabled
(`CHOKIDAR_USEPOLLING`/`WATCHPACK_POLLING`) because inotify events don't cross
the macOS↔container bind mount reliably.

```bash
# prove it: edit any component's text under src/, save — the running page at
# http://localhost:3000 updates without a manual reload. `docker compose logs ui`
# shows "Compiling..." / "Compiled successfully".
```

## 8. Data

**DynamoDB** (created by `floci-init` in region **us-east-2** — see §10):

| Table | Keys |
|---|---|
| `GroovTempTableV2` | `PK` / `SK` |
| `GroovTempTableV2Processed` | `PK` / `SK` |
| `groov_db_table_v2` (prod-shaped) | `category` / `grv_id` |

**S3 buckets:**

- **`groov-local-static`** — public-read, path-style, CORS for
  `http://localhost:3000`. Serves the offline static-browse fixture (~254 real
  V2 sensors, seeded from `scripts/s3_v2/`) that the UI reads instead of
  `groov-api.com`. Seeded keys: `v2/index.json`, `v2/indexes/<family>.json`,
  `v2/sensors/<family>/<GRV-ID>.json`, `v2/all-sensors.json`, root
  `index.json` / `all-sensors.json`, and `feature-flags.json` (all V2 flags
  `true`). This same bucket is the write target for approve/delete/fingerprint,
  so mutating a sensor through the local API updates what the UI browses.
- `groov-local-deploy` — private, internal (staging the rdkit layer zip, which
  exceeds the 50 MB direct-upload limit). Not user-facing.

**Static base:** the UI's `REACT_APP_STATIC_BASE` defaults to
`http://localhost:4566/groov-local-static` (fully offline). To browse real prod
data from a local UI instead, override `REACT_APP_STATIC_BASE=https://groov-api.com`.

**Fingerprints / rdkit:** the fingerprint path is real, not stubbed.
`updateFingerprintV2` runs on `python3.12` with a real `rdkit` layer, and
`approveProcessedSensorV2` / `deleteSensorV2` invoke it for real
(`FINGERPRINT_LAMBDA_NAME=updateFingerprintV2`) — approving a sensor
regenerates its fingerprint into `groov-local-static`.

## 9. Everyday commands

```bash
docker compose up                 # start (foreground); add -d to detach
docker compose down               # stop, KEEP volumes (data persists)
docker compose down -v            # stop and WIPE volumes (fresh state)
docker compose logs -f <service>  # follow logs: floci | floci-init | ui
docker compose build ui           # rebuild the UI image (after package.json changes)
docker compose up --build         # rebuild changed images, then start

# rebuild the Lambda layers (only if their deps change):
bash layers/python-v2/build.sh    # requests + pydantic + groov_models + python-jose
bash layers/rdkit/build.sh        # rdkit + numpy + Pillow (aarch64)
```

### Re-standup: use `down -v && up`

```bash
docker compose down -v && docker compose up
```

**Why:** `floci-init` mints a **new API id on every run** and Floci does not
persist state across restarts. A bare `docker compose up` on an existing stack
can re-run provisioning and leave an orphaned old API id while the already-running
UI still points at the previous one — a confusing desync. The clean
`down -v && up` cycle guarantees the API, the seeded data, and the UI's
`/shared/ui.env` are all in sync.

## 10. Troubleshooting / gotchas

- **Split region (by design).** API Gateway, Cognito, and Lambda run in
  **us-east-1** (Floci resolves header-less browser requests to us-east-1;
  anything else 404s on invoke). But the V2 handlers hardcode
  `region_name="us-east-2"` for DynamoDB, and Floci scopes DynamoDB **per
  region**, so the tables are created in **us-east-2** to be visible to that
  code. If `aws dynamodb list-tables` looks empty, query
  `--region us-east-2`. (S3 is region-agnostic in Floci.)
- **New API id each run / UI desync.** See §9 — re-standup with
  `docker compose down -v && docker compose up`.
- **`addNewSensorV2` can time out (~30s).** Its UniProt + DOI + NCBI-operon
  enrichment chain can exceed the HTTP API's 30s integration timeout for a
  slow/large-genome protein. This mirrors the same constraint in prod's
  `AWS_PROXY`/`HttpApi` config — not Floci-specific.
- **Port already in use (3000 / 4566).** Something else is bound to the port.
  Stop it (or the old stack: `docker compose down`) and retry.
- **"Cannot connect to the Docker daemon."** Docker Desktop isn't running — start
  it, then `docker compose up`.
- **UI booted with the prod API base.** The entrypoint waits up to 60s for
  `floci-init` to write `/shared/ui.env`; if it warns
  `WARNING /shared/ui.env not found`, provisioning was slow/failed — check
  `docker compose logs floci-init` and re-standup.

## 11. Environment variable reference

| Variable | Where it's set | Consumed by / effect |
|---|---|---|
| `REACT_APP_API_BASE` | `floci-init` → `/shared/ui.env` (per-run) | UI `src/lib/config.js`; the V2 Lambda API base. Local: `http://localhost:4566/execute-api/<API_ID>/dev`. Prod fallback: `https://api.groov.bio`. |
| `REACT_APP_STATIC_BASE` | UI `.env.development` | UI static browse reads. Local: `http://localhost:4566/groov-local-static`. Prod fallback/override: `https://groov-api.com`. |
| `REACT_APP_LOCAL_AUTH` | UI `.env.development` (`true`) | Master gate for the local-auth shim in `src/utils/auth.js`. Unset in prod. |
| `REACT_APP_COGNITO_REGION` | UI `.env.development` (`us-east-1`) | `aws-exports.js` / auth shim. Prod fallback: `us-east-2`. |
| `REACT_APP_COGNITO_USER_POOL_ID` | `floci-init` → `/shared/ui.env` (per-run) | `aws-exports.js` / auth shim. Prod fallback: `us-east-2_JO965QtEP`. |
| `REACT_APP_COGNITO_CLIENT_ID` | `floci-init` → `/shared/ui.env` (per-run) | `aws-exports.js` / auth shim. Prod fallback: `2lhdpnuct7nfirl2q8fkq8i2ie`. |
| `REACT_APP_COGNITO_ENDPOINT` | UI `.env.development` (`http://localhost:4566`) | Local-auth `InitiateAuth` target. No prod equivalent (Amplify talks to AWS directly). |
| `IS_LOCAL` | `floci-init` per-function `--environment` (`true`) | Function `_table()`/`_s3_client()` helpers skip the prod-only endpoint/region hardcodes and let boto3 use the injected Floci endpoint. |
| `AWS_ENDPOINT_URL` | Auto-injected by Floci into each Lambda (`http://localhost.floci.io:4566`); also set on `floci-init` (`http://floci:4566`) | boto3 auto-targets Floci for all AWS calls — no per-service endpoint override in code. |
| `FINGERPRINT_LAMBDA_NAME` | `floci-init` on approve/delete fns (`updateFingerprintV2`) | Enables the real rdkit fingerprint invoke (left unset → skipped). |
| Region (`AWS_DEFAULT_REGION`) | `floci-init` = `us-east-1`; DynamoDB tables + handler boto3 = `us-east-2`; S3 = region-agnostic | See §10 split-region note. |

## 12. How local differs from prod (don't mistake one for the other)

| | Local (this stack) | Production |
|---|---|---|
| Backend | Floci emulation on `:4566` | Real AWS |
| Scope | V2 only | V1 + V2 |
| Admin authorizer | **Python** (`adminAuthorizer.py`) | **Node** (`adminAuthorizer.js`, `aws-jwt-verify`) |
| Login | `USER_PASSWORD_AUTH` shim (seeded admin) | Cognito Hosted UI (`federatedSignIn`) |
| Cognito region | us-east-1 (emulated pool) | us-east-2 (real pool `us-east-2_JO965QtEP`) |
| DynamoDB region | us-east-2 (in Floci) | us-east-2 (real) |
| Deploy definition | `floci/provision.sh` (CLI mirror) | `template.yaml` (SAM) — **untouched by local** |

`floci/provision.sh` is a deliberately thin mirror of the V2 slice of
`template.yaml`; each block references the template resource it mirrors so drift
is visible on a diff. `template.yaml` remains the single source of truth for
production.
