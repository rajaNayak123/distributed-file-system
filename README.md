# Distributed File Storage Backend

A production-style, "mini Dropbox/Google Drive backend" built as a portfolio project — not a simple CRUD file-upload app. It demonstrates the distributed systems patterns that separate a toy upload endpoint from a resilient production system: object storage instead of local disk, stateless horizontally scalable API instances, explicit upload state machines, async work decoupled via SQS, S3/DynamoDB eventual-consistency handled via active reconciliation, storage deduplication, and cross-instance rate limiting.

**Why the basic version (a single Express server writing uploads to local disk) is not enough:** it cannot scale past one instance without sharing a filesystem (single point of failure and bottleneck) or losing files when requests hit another replica. It cannot resume large failed uploads, leaks storage on uncompleted uploads, and provides no mechanism to keep object storage and metadata consistent when partial failures occur. This project addresses each of those challenges.

---

## Project Status

- [x] **Phase 1 — Working MVP**: JWT auth (register/login/refresh), user model, thin S3/DynamoDB wrappers, direct metadata endpoints, strict ownership checks.
- [x] **Phase 2 — Correct Upload Architecture**: Direct-to-S3 presigned uploads, explicit `INITIATED -> UPLOADING -> COMPLETING -> COMPLETED / FAILED` state machine, S3 `HeadObject` completion verification, presigned downloads, idempotent delete.
- [x] **Phase 3 — Large Files (Multipart Upload)**: S3 multipart upload lifecycle (`initiate`, `parts`, `complete`, `abort`), per-part retries, idempotent part URL generation, automated cleanup of abandoned uploads.
- [x] **Phase 4 — Distributed API & Statelessness**: Multi-stage Docker packaging, 3 stateless API replicas (`api-1`, `api-2`, `api-3`), Nginx load balancer reverse proxy with health-based routing, liveness (`/health`) and readiness (`/ready`) probes, zero local disk byte writes enforced by static code analysis test.
- [x] **Phase 5 — Reliability & Resilience**: DynamoDB-backed `IdempotencyKeys` table with atomic locks, payload hash validation (422), in-flight collision protection (409), AWS SDK connection/socket timeouts (`NodeHttpHandler`), global request timeout middleware, exponential backoff with jitter, validation error retry bypass, and resilient upload retry via `POST /files/:id/retry`.
- [x] **Phase 6 — Event-Driven Processing**: SQS main queue (`file-processing-queue`) and dead-letter queue (`file-processing-dlq`, `maxReceiveCount=5`, visibility timeout 300s), upload completion event emission (`FILE_UPLOADED`), standalone `apps/worker` application with horizontal scalability (2 worker replicas), async SHA-256 checksumming, metadata validation, and DLQ CLI inspection script.
- [x] **Phase 7 — Advanced Features**: Two-way Reconciliation processor (Case A: missing S3 objects marked `FAILED`; Case B: orphan S3 objects purged), content-addressed storage deduplication using DynamoDB `ContentHashIndex` GSI and atomic `refCount`, and distributed shared-state rate limiting using Redis with standard `X-RateLimit-*` and `Retry-After` headers.
- [ ] **Phase 8 — Production Proof**: CI/CD pipeline (GitHub Actions), Prometheus/Grafana observability, k6 distributed load testing, and failure testing against live infrastructure.

---

## Architecture Overview

```
                       ┌───────────────────────────────────────────────────────────┐
External traffic       │                  docker-compose network                   │
http://localhost:3000  │                                                           │
        │              │   ┌─────────────────────────────────────────────────┐     │
        ▼              │   │  nginx (port 80 → host 3000)                    │     │
  ┌──────────┐         │   │  round-robin + health-check (/ready)            │     │
  │  nginx   │─────────┼──►│  ALB stand-in (see infra/docker/nginx.conf)     │     │
  └──────────┘         │   └───────────────┬─────────────────────────────────┘     │
                       │                   │ round-robin                           │
                       │    ┌──────────────▼────────────────────────────────┐      │
                       │    │      api-1         api-2         api-3        │      │
                       │    │    (Express, stateless horizontal replicas)    │      │
                       │    └───────┬────────────────┬───────────────┬──────┘      │
                       │            │                │               │             │
                       │            ▼                │               ▼             │
                       │     ┌─────────────┐         │        ┌──────────────┐     │
                       │     │    Redis    │◄────────┘        │  DynamoDB    │     │
                       │     │  (port 6379)│                  │  Local       │     │
                       │     │ Shared rate │                  │  (Files +    │     │
                       │     │ limit state │                  │  ContentHash │     │
                       │     └─────────────┘                  │  GSI)        │     │
                       │                                      └──────────────┘     │
                       │                                             ▲             │
                       │                                             │             │
                       │    ┌──────────────────────────────────┐     │             │
                       │    │  LocalStack (S3 + SQS)           │     │             │
                       │    │  - S3 bucket: file-storage-dev   │     │             │
                       │    │  - file-processing-queue         │     │             │
                       │    └──────────────────┬───────────────┘     │             │
                       │                       │                     │             │
                       │                       ▼                     │             │
                       │        ┌──────────────────────────────┐     │             │
                       │        │  worker-1        worker-2    │─────┘             │
                       │        │  - SQS consumer (checksum,   │                   │
                       │        │    metadata, deduplication)  │                   │
                       │        │  - Cron 1: cleanup (hourly)  │                   │
                       │        │  - Cron 2: reconciliation    │                   │
                       │        │    (every 15 min)            │                   │
                       │        └──────────────────────────────┘                   │
                       └───────────────────────────────────────────────────────────┘
```

---

## Repo Structure

```
distributed-file-storage/
├── apps/
│   ├── api/                     # Express API service (ES Modules)
│   │   ├── src/
│   │   │   ├── clients/         # AWS SDK v3 clients (S3, DynamoDB, SQS)
│   │   │   ├── config/          # Environment configuration
│   │   │   ├── controllers/     # HTTP endpoint handlers
│   │   │   ├── middlewares/     # Auth, idempotency, rate limiting, logging, timeouts
│   │   │   ├── repositories/    # DynamoDB data access (Files, Users, Idempotency)
│   │   │   ├── routes/          # Express route definitions
│   │   │   ├── services/        # Business logic & AWS SDK wrappers
│   │   │   └── utils/           # State machine, error definitions, hashing, logger
│   │   └── tests/
│   │       ├── fakes/           # In-memory test doubles for isolated integration testing
│   │       ├── failure/         # Chaos & failure tests (S3 timeout, DynamoDB fail, idempotency)
│   │       ├── integration/     # Presigned lifecycle, multipart, dedup delete, rate limiting
│   │       └── unit/            # Unit tests & static noDiskWrites verification guard
│   └── worker/                  # Event-driven background processor (ES Modules)
│       ├── scripts/             # inspect-dlq.js (CLI tool to inspect Dead Letter Queue)
│       ├── src/
│       │   ├── clients/         # S3, DynamoDB, SQS clients
│       │   ├── config/          # Worker configuration (queues, schedules, cutoffs)
│       │   ├── consumer.js      # Long-polling SQS consumer with non-ack on failure
│       │   ├── processors/      # Checksum, metadata validation, cleanup, reconciliation
│       │   ├── repositories/    # Worker DynamoDB repository
│       │   └── worker.js        # Entrypoint initializing consumer and cron jobs
│       └── tests/
│           ├── integration/     # Pipeline, worker crash redelivery, DLQ routing tests
│           └── unit/            # Processors unit tests (checksum, metadata, cleanup, dedup, reconciliation)
├── infra/
│   └── docker/                  # Nginx configuration, DynamoDB init script, LocalStack setup
├── docs/
│   ├── api.md                   # Complete REST endpoint contract reference
│   ├── architecture.md          # In-depth architectural diagrams and decision explanations
│   ├── decisions.md             # ADR (Architecture Decision Record) log
│   └── failure-scenarios.md     # Observed failure behavior matrix across all phases
├── tests/
│   ├── failure/                 # crash-tolerance.md documentation
│   └── load/                    # crash-tolerance.sh demo script
├── docker-compose.yml           # Local dev orchestrator (LocalStack, DynamoDB, Redis, 3 APIs, 2 Workers, Nginx)
└── README.md
```

---

## Local Setup & Development

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Node.js 18+ (if running tests or apps directly on host)

### Running the Full System Locally
1. Copy the example environment file:
```bash
cp .env.example .env
```
2. Build and start the entire cluster:
```bash
docker compose up --build -d
```

This provisions:
- **LocalStack** (`:4566`): S3 bucket `file-storage-dev` and SQS queues (`file-processing-queue`, `file-processing-dlq`).
- **DynamoDB Local** (`:8000`): Tables `Files` (with `ContentHashIndex` GSI), `Users` (with `EmailIndex` GSI), and `IdempotencyKeys`.
- **Redis** (`:6379`): Distributed in-memory counter store for rate limiting.
- **API Replicas** (`api-1`, `api-2`, `api-3`): Stateless application servers running Node 20 LTS as non-root users.
- **Worker Replicas** (`worker-1`, `worker-2`): Concurrent queue consumers.
- **Nginx Load Balancer** (`:3000`): Round-robin proxy directing traffic to healthy API instances.
- **Frontend Dashboard** (`:5173`): React + Tailwind v4 web UI with built-in API proxy to the load balancer.

Check cluster readiness:
```bash
curl http://localhost:3000/ready
```

Open the dashboard in your browser at [http://localhost:5173](http://localhost:5173).

*(Optional) For local frontend development with HMR outside Docker:*
```bash
cd frontend
npm install
npm run dev
```

---

## Testing

### API Test Suite (Unit, Integration, Failure)
Runs 17 test suites (92 tests) covering upload state machines, presigned URLs, multipart uploads, rate limiting, and failure scenarios:
```bash
cd apps/api
npm test
```

### Worker Test Suite (Unit & Integration)
Runs 8 test suites (27 tests) covering checksum computation, metadata validation, deduplication, cleanup cron, two-way reconciliation, and DLQ routing:
```bash
cd apps/worker
npm test
```

### Crash-Tolerance Demonstration (Phase 4)
With Docker Compose running, execute the automated crash tolerance demonstration:
```bash
bash tests/load/crash-tolerance.sh
```
This script fires 40 sequential upload-initiation requests, terminates `api-2` mid-traffic, and asserts that 100% of requests succeed through the remaining healthy replicas without data loss.

### Inspecting the Dead Letter Queue
To inspect poisoned or failing messages in the DLQ:
```bash
cd apps/worker
npm run inspect-dlq
```
