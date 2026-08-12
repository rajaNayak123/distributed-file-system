# Distributed File Storage Backend

A production-style, "mini Dropbox/Google Drive backend" built as a portfolio
project - not a simple CRUD file-upload app. It exists to demonstrate the
patterns that separate a toy upload endpoint from a system that could actually
run in production: object storage instead of local disk, stateless horizontally
-scalable API instances, explicit state machines instead of booleans, async
work decoupled via a queue, S3/DynamoDB eventual-consistency handled
explicitly rather than assumed away, and every claim backed by tests and real
load-test numbers rather than described in prose.

**Why the basic version (a single Express server writing uploads to local
disk) is not enough:** it can't run more than one instance without either
sharing a filesystem (which reintroduces a single point of failure and a
scaling bottleneck) or losing files whenever a request lands on the "wrong"
instance. It has no way to resume a failed large upload, no way to recover
from a crash mid-upload without leaking storage or losing data, and no
mechanism to keep two independent systems (object storage and metadata)
consistent when one write succeeds and the other doesn't. This project builds
the corrected version of each of those problems, one phase at a time.

## Project status

This repo is built in 8 phases; only the phases listed below are implemented
so far.

- [x] **Phase 1 - Working MVP**: JWT auth, users, thin S3/DynamoDB wrappers, a
      basic (through-the-API) upload endpoint, list/get with ownership checks.
- [x] **Phase 2 - Correct Upload Architecture**: presigned S3 uploads, the
      `INITIATED -> UPLOADING -> COMPLETING -> COMPLETED / FAILED` state
      machine, S3-verified completion, presigned downloads (gated on
      `status === COMPLETED`), idempotent delete.
- [ ] Phase 3 - Large files via S3 multipart upload
- [ ] Phase 4 - Distributed API (multi-instance, load balancing, health checks)
- [ ] Phase 5 - Reliability (idempotency keys, timeouts, retry/backoff)
- [ ] Phase 6 - Event-driven processing (SQS, workers, DLQ, checksums)
- [ ] Phase 7 - Reconciliation, deduplication, rate limiting
- [ ] Phase 8 - CI/CD, monitoring, load/failure testing, final docs

## Module system: ES Modules, not CommonJS

`apps/api` (and the small `infra/docker` init script) run as native **ES
Modules** - `package.json` sets `"type": "module"`, every file uses
`import`/`export`, and relative imports include explicit `.js` extensions
(required by Node's ESM resolver, unlike CommonJS). `node src/server.js` runs
this directly - there is no build/transpile step for running the app. The one
place CommonJS still shows up is testing: Jest itself is built on `require()`
internals, so `babel.config.cjs` + `babel-jest` transpile the ES Module source
to CommonJS *only* for the test run (see `docs/decisions.md`). `jest.config.cjs`
and `babel.config.cjs` are deliberately named `.cjs` so they parse correctly
under a `"type": "module"` package.

## Repo structure

Organized by **layer** (controllers / routes / services / repositories /
middlewares / utils), not by domain module. See `docs/decisions.md` for why
this replaced an earlier domain-folder layout (`auth/`, `files/`, `uploads/`,
each bundling its own controller+service+routes).

```
distributed-file-storage/
├── apps/
│   ├── api/                     # Express API (Phase 1/2 implemented, ESM)
│   │   ├── src/
│   │   │   ├── app.js           # Express app wiring
│   │   │   ├── server.js        # entrypoint
│   │   │   ├── config/          # env var loading
│   │   │   ├── clients/         # shared S3Client / DynamoDBDocumentClient instances
│   │   │   ├── controllers/     # HTTP request/response handling (thin - delegates to services)
│   │   │   ├── routes/          # Express Router wiring per resource
│   │   │   ├── services/        # business logic + AWS SDK wrappers (storage/metadata)
│   │   │   ├── repositories/    # domain-specific DynamoDB access patterns (Files, Users)
│   │   │   ├── middlewares/     # authGuard, requestId, requestLogger, errorHandler, notFound
│   │   │   └── utils/           # errors, logger, validators, upload state machine
│   │   └── tests/
│   │       ├── unit/            # services/repositories/state-machine/disk-write guard (mocked AWS SDK)
│   │       ├── integration/     # full request flows against in-memory fakes (see note below)
│   │       ├── fakes/           # in-memory FilesRepository/UsersRepository/StorageService test doubles
│   │       └── helpers/
│   └── worker/                  # not yet built - starts in Phase 6
├── infra/
│   └── docker/                  # DynamoDB Local table-init job (ESM), LocalStack init hooks
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── decisions.md
│   └── failure-scenarios.md
├── docker-compose.yml
└── README.md (this file)
```

## Local setup

Requires Docker + Docker Compose, and Node.js 18+ if you want to run the API
outside a container.

```bash
# from the repo root
docker-compose up --build
```

This brings up:
- `localstack` - S3 (+ SQS, unused until Phase 6) on `:4566`, with an init hook
  that creates the `file-storage-dev` bucket automatically.
- `dynamodb-local` - DynamoDB Local on `:8000`.
- `dynamodb-init` - a one-shot job that creates the `Files` and `Users` tables
  (with the `EmailIndex` GSI on `Users`), then exits.
- `api` - the Express API on `:3000`, waiting on the above via
  `depends_on`/healthchecks.

To run the API directly on the host instead (useful for `npm run dev` with
hot reload against the same LocalStack/DynamoDB Local containers):

```bash
cd apps/api
cp .env.example .env
npm install
npm run dev
```

### Running tests

```bash
cd apps/api
npm test               # unit + integration
npm run test:unit
npm run test:integration
```

**Note on integration tests:** the integration suite exercises the real
Express app, routing, auth, validation, and the full upload/download/delete
business logic, but swaps `FilesRepository`, `UsersRepository`, and
`StorageService` for in-memory fakes (see `apps/api/tests/fakes/` and the
`integration` Jest project in `apps/api/jest.config.cjs`) rather than a live
LocalStack/DynamoDB Local instance, since those weren't available in the
environment this was drafted in. The fakes implement identical method
signatures to the real classes. Phase 8's CI workflow is written to run this
same suite against real LocalStack + DynamoDB Local service containers; that
path has not yet been executed. Unit tests for the storage/metadata *service*
wrapper modules and the `FilesRepository`/`UsersRepository` classes *do*
exercise the real AWS SDK v3 client classes, via `aws-sdk-client-mock`.

Both `npm run dev`/`npm start` (native ESM via Node) and the actual HTTP
server have been smoke-tested directly in this environment - `GET /health`
returns `200`, and `POST /auth/register` correctly surfaces a
`502 UPSTREAM_SERVICE_ERROR` when no real DynamoDB is reachable, proving the
whole request/response/error-handling pipeline works outside of Jest too.

### Verifying no file bytes touch the API's disk

The API process never opens a write stream to local disk for uploaded content
- `express.json()` is the only body parser configured (1MB limit, JSON only),
there is no `multer`/raw-body upload middleware wired into any route, and
`storage.service.js` only ever streams to/from S3 or generates presigned URLs.
This is enforced as an actual test, not just a claim: see
`apps/api/tests/unit/noDiskWrites.test.js`, which statically scans `src/` for
`multer`, `fs.writeFile*`, `fs.createWriteStream`, and `fs.appendFile` and
fails the build if any appear.

## Environment variables

See `apps/api/.env.example`. No secrets are committed; local dev defaults
point at LocalStack/DynamoDB Local with the standard `test`/`test` dummy AWS
credentials those tools expect.

## Trade-offs and what's next

Phase 2 deliberately does not yet handle: files above a size threshold (no
multipart - Phase 3), running more than one API instance (Phase 4), retries/
backoff/idempotency keys for network failures (Phase 5), async checksum
computation (Phase 6), S3/DynamoDB reconciliation after a partial failure,
deduplication, or rate limiting (Phase 7), and there's no CI pipeline, load
testing, or metrics dashboard yet (Phase 8). Each is scoped in the phase
document and will be layered on without re-architecting what's already here.
