# groov-db-api

Serverless backend (AWS SAM) for the groovDB biosensor database. The live API is **V2**:
Python 3.14 Lambdas under `functions/` (the `*V2` functions), validated with the shared
Pydantic models in `layers/python-v2/shared/groov_models.py`. A few support functions
(docs, admin authorizer, contact form) are Node.js. The deployed surface is defined in
`template.yaml`; the OpenAPI spec is `functions/docs/swagger.yaml` (served at `GET /swagger`).

## The `archive/` directory — dead code, do not touch

`archive/` holds the **retired V1 (Node.js) Lambda functions and their tests**. They were
removed from `template.yaml` and no longer deploy. This code is frozen history, kept only
for reference (see `archive/README.md`).

- **Do not modify** anything under `archive/`. It is not live code — never edit, refactor,
  fix, or "update" it, even if it looks broken or out of date. That's expected: it's dead.
- **Do not grep/search it by default.** Scope searches to the live code (`functions/`,
  `layers/`, `scripts/`) and exclude `archive/`. V1 and V2 share many function and handler
  names, so unfiltered matches from `archive/` are misleading and will surface stale V1
  code as if it were current.
- You **may read** a specific file here as a historical reference for how the old V1
  behavior worked — but treat it as history, never cite it as the current implementation,
  and don't base changes on it. The live equivalents are the `*V2` functions in `functions/`.
