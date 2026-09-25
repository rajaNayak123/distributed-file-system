# Distributed File Storage System

[![Node.js](https://img.shields.io/badge/Node.js-20_LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker_Compose-Multi--Container-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![AWS SDK v3](https://img.shields.io/badge/AWS_SDK-v3-FF9900?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/sdk-for-javascript/)
[![DynamoDB](https://img.shields.io/badge/DynamoDB-Single--Table_Design-4053D6?logo=amazon-dynamodb&logoColor=white)](https://aws.amazon.com/dynamodb/)
[![Redis](https://img.shields.io/badge/Redis-7_Alpine-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Tests](https://img.shields.io/badge/Tests-119_Passed-brightgreen?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A resilient, cloud-native distributed file storage engine and interactive dashboard inspired by Google Drive and Dropbox. Engineered from first principles to demonstrate production distributed systems patterns: **direct-to-object-storage streaming (zero API disk writes)**, **stateless horizontal API scaling**, **multipart upload chunking**, **content-addressed storage deduplication**, **asynchronous SQS event pipelines**, **two-way active reconciliation**, and **distributed sliding-window rate limiting**.

---

## Table of Contents

- [The Core Problem](#the-core-problem)
- [System Architecture](#system-architecture)
- [Key Engineering Capabilities](#key-engineering-capabilities)
- [Service Topology & Port Matrix](#service-topology--port-matrix)
- [Technology Stack](#technology-stack)
- [Repository Structure](#repository-structure)
- [Getting Started & Local Setup](#getting-started--local-setup)
- [Terminal Quickstart (cURL Walkthrough)](#terminal-quickstart-curl-walkthrough)
- [Storage Deduplication in Action](#storage-deduplication-in-action)
- [API Quick Reference](#api-quick-reference)
- [Resilience & Failure Matrix](#resilience--failure-matrix)
- [Testing & Chaos Verification](#testing--resilience-verification)
- [Environment Configuration](#environment-configuration)
- [Troubleshooting & Operations](#troubleshooting--operations)
- [Documentation Index](#documentation-index)
- [License](#license)

---

## The Core Problem

Traditional file upload architectures route binary file streams directly through an application server (e.g., using `multer` in Express) and write them to the host's local disk. In high-scale distributed environments, this naive pattern fails:

- **Statefulness Bottleneck**: Replicas bound to local storage cannot scale horizontally behind a load balancer without a shared filesystem (NFS/EFS), which rapidly turns into a single point of failure and I/O bottleneck.
- **Node.js Resource Starvation**: High-throughput binary streaming locks HTTP sockets, consumes event-loop cycles, and congests memory buffers, choking lightweight metadata endpoints.
- **Zombie Storage & Incomplete Transfers**: Network drops during multi-gigabyte uploads leave orphaned chunks on disk with no tracking or automated garbage collection.
- **Eventual Consistency Drift**: Network partitions and crash failures cause database metadata and physical object storage to drift out of sync.

### How This System Solves It

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ NAIVE APPROACH (Anti-Pattern)                                                          │
│ Client ──[Full Binary Stream]──► API Server (Buffer in RAM/Disk) ──► Local Filesystem  │
│ ❌ Single point of failure  ❌ High memory/socket footprint  ❌ Cannot scale replicas  │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│ DISTRIBUTED ARCHITECTURE (This System)                                                 │
│ 1. Client ──[Metadata Request]──► Stateless API Cluster ──► S3 Presigned PUT URL       │
│ 2. Client ──[Direct Binary Upload (Presigned URL)]───────► AWS S3 Bucket (Zero API I/O)│
│ 3. Client ──[Complete Signal]────► API Server ──► Verify HeadObject ──► Emit SQS Event│
│ 4. SQS Queue ────────────────────► Worker Fleet ──► SHA-256 Checksum + Deduplication   │
│ ✅ Zero API disk writes  ✅ Horizontally scalable  ✅ Auto-healed via reconciliation   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## System Architecture

```
                                  [ Client Browser / Frontend (Port 5173) ]
                                             │               │
                            1. Direct Upload │               │ API Requests
                               (Presigned)   │               │ (JWT, metadata)
                                             ▼               ▼
                                       ┌──────────┐    ┌──────────┐
                                       │  AWS S3  │    │  Nginx   │ (Port 3000)
                                       │ (Storage)│    │  LB      │
                                       └──────────┘    └────┬─────┘
                                             ▲              │ Round-robin (/ready check)
                        Worker Reads/Purges  │              ▼
                        ─────────────────────┼─ ┌───────────────────────┐
                                             │  │  API Cluster (3 Nodes)│
                                             │  │  api-1, api-2, api-3  │
                                             │  └───────┬───────────────┘
                                             │          │
                                             │          ├──► Redis (Port 6379)
                                             │          │    [Shared Rate Limiting]
                                             │          │
                                             │          ├──► DynamoDB Local (Port 8000)
                                             │          │    [Users, Files, IdempotencyKeys]
                                             │          │
                                             │          └──► AWS SQS (Port 4566)
                                             │               [file-processing-queue]
                                             │                     │
                                             │                     ▼
                                       ┌─────┴─────────────────────────┐
                                       │  Worker Fleet (worker-1, -2)  │
                                       │  - SQS Consumer (Checksum)    │
                                       │  - Deduplication Engine       │
                                       │  - DLQ Error Quarantine       │
                                       │  - Hourly Cleanup Cron        │
                                       │  - 15-min Reconciliation Cron │
                                       └───────────────────────────────┘
```

---

## Key Engineering Capabilities

### 1. Direct-to-S3 Presigned Uploads (Zero API Disk Writes)
- Clients obtain a time-limited (15m) cryptographically signed S3 `PUT` URL.
- File bytes stream straight from client to object storage.
- An automated static code analysis guard (`apps/api/tests/unit/noDiskWrites.test.js`) runs in CI to verify that no `fs.writeFile`, `fs.createWriteStream`, or local disk caching calls exist in the API layer.

### 2. S3 Multipart Upload Engine (Large File Orchestration)
- Files >100MB up to gigabytes are orchestrated via AWS S3 Multipart Upload API.
- Files are sliced into 5MB chunks and uploaded concurrently with per-part presigned URLs.
- Supports individual part retry, upload resumption, and deterministic completion or abort.
- Abandoned multipart uploads are automatically purged after 24 hours.

### 3. Stateless Horizontally Scaled API Cluster
- 3 containerized Express API replicas (`api-1`, `api-2`, `api-3`) fronted by an Nginx reverse proxy.
- Liveness (`/health`) and readiness (`/ready`) endpoints ensure zero-downtime routing. Degraded replicas failing downstream dependency checks are automatically removed from the round-robin pool.

### 4. Content-Addressed Storage Deduplication
- Upon upload completion, background workers stream the file to compute its cryptographic SHA-256 digest.
- DynamoDB's `ContentHashIndex` Global Secondary Index (GSI) identifies duplicate files.
- Duplicate uploads point to the canonical S3 key while the redundant S3 object is purged.
- Atomic reference counting (`refCount`) protects the underlying physical blob until the final file reference is deleted.

### 5. Asynchronous Event-Driven Pipeline & Dead-Letter Queue (DLQ)
- File completion emits a `FILE_UPLOADED` event to AWS SQS (`file-processing-queue`).
- 2 worker replicas run SQS long polling (`WaitTimeSeconds = 20`) with 300s visibility timeouts.
- Unhandled worker errors trigger non-acknowledgment; messages failing 5 consecutive attempts are quarantined in `file-processing-dlq`.
- Operators can inspect and redrive quarantined messages via a built-in CLI tool (`npm run inspect-dlq`).

### 6. Two-Way Active Reconciliation Loop
- A background cron task runs every 15 minutes to heal state drift:
  - **Case A (Database Ghost Records)**: DynamoDB files marked `COMPLETED` whose S3 object is missing or corrupted are transitioned to `FAILED`.
  - **Case B (S3 Orphan Objects)**: Objects in S3 without corresponding DynamoDB records (and older than a 2-hour safety threshold) are purged.

### 7. Distributed Shared-State Rate Limiting
- Backed by an in-memory Redis cluster to enforce global rate limits across all API replicas.
- Returns RFC-compliant HTTP headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After: <seconds>` on `429 Too Many Requests`.

### 8. Idempotency & Concurrency Guards
- Mutation endpoints support the `Idempotency-Key` header with DynamoDB atomic locks.
- Concurrent duplicate requests return `409 Conflict`.
- Reused keys with altered payload parameters return `422 Unprocessable Entity`.
- Completed requests replay cached JSON responses without duplicate downstream side effects.

### 9. Modern Web Dashboard
- Single-page application built with React 19, TypeScript, and Tailwind CSS v4.
- Real-time S3 upload progression (transfer speed, percentage, ETA), multipart upload chunk visualization, deduplication badges, and cluster health monitoring.

---

## Service Topology & Port Matrix

| Service | Container Name | Host Port | Role | Health Endpoint |
| :--- | :--- | :--- | :--- | :--- |
| **Nginx Load Balancer** | `nginx` | `:3000` | Reverse proxy, round-robin load distribution | `/ready` |
| **API Fleet (3 Replicas)** | `api-1`, `api-2`, `api-3` | Internal | Stateless Express REST API services | `/health`, `/ready` |
| **Worker Fleet (2 Replicas)** | `worker-1`, `worker-2` | Internal | SQS consumer, deduplication, crons | Process Monitor |
| **LocalStack** | `localstack` | `:4566` | Emulates AWS S3 (`file-storage-dev`) & AWS SQS | `/_localstack/health` |
| **DynamoDB Local** | `dynamodb-local` | `:8000` | Fast NoSQL document store (`Files`, `Users`, `IdempotencyKeys`) | `:8000/shell` |
| **Redis** | `redis` | `:6379` | In-memory distributed counter & rate-limiting store | `PING` &rarr; `PONG` |
| **Web Dashboard** | `frontend` | `:5173` | React 19 SPA with built-in API proxy | HTTP 200 |

---

## Technology Stack

- **Backend Runtime**: Node.js 20 LTS (Native ES Modules)
- **API Framework**: Express 4.x
- **Cloud SDK**: AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-sqs`, `@aws-sdk/s3-request-presigner`)
- **Database & Storage**: Amazon DynamoDB, Amazon S3, Amazon SQS (LocalStack / DynamoDB Local)
- **Caching & Rate Limiting**: Redis 7 Alpine, `ioredis`
- **Reverse Proxy**: Nginx 1.27 Alpine
- **Frontend App**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Vite
- **Testing**: Vitest, Supertest, Custom In-Memory Test Doubles, Bash Chaos Harness

---

## Repository Structure

```
distributed-file-storage/
├── apps/
│   ├── api/                     # Express REST API service (ES Modules)
│   │   ├── src/
│   │   │   ├── clients/         # AWS SDK v3 clients (S3, DynamoDB, SQS, Redis)
│   │   │   ├── config/          # Environment variables & runtime constants
│   │   │   ├── controllers/     # HTTP endpoint controllers
│   │   │   ├── middlewares/     # Auth, idempotency, rate limiting, logging, timeouts
│   │   │   ├── repositories/    # DynamoDB data access (Files, Users, Idempotency)
│   │   │   ├── routes/          # Express route definitions
│   │   │   ├── services/        # Business logic & S3 presigning wrappers
│   │   │   └── utils/           # State machines, error definitions, hashing, logger
│   │   └── tests/
│   │       ├── fakes/           # In-memory test doubles for deterministic testing
│   │       ├── failure/         # Chaos & failure tests (S3 timeout, DynamoDB fail)
│   │       ├── integration/     # Presigned lifecycle, multipart, dedup, rate limiting
│   │       └── unit/            # Unit tests & static noDiskWrites verification guard
│   └── worker/                  # Event-driven background processor (ES Modules)
│       ├── scripts/             # inspect-dlq.js (CLI tool to inspect Dead-Letter Queue)
│       ├── src/
│       │   ├── clients/         # S3, DynamoDB, SQS clients
│       │   ├── config/          # Worker configuration (queues, schedules, cutoffs)
│       │   ├── consumer.js      # Long-polling SQS consumer with non-ack on failure
│       │   ├── processors/      # Checksum, metadata validation, cleanup, reconciliation
│       │   ├── repositories/    # Worker DynamoDB repository
│       │   └── worker.js        # Entrypoint initializing consumer and cron jobs
│       └── tests/
│           ├── integration/     # Pipeline, worker crash redelivery, DLQ routing tests
│           └── unit/            # Processors unit tests (checksum, metadata, cleanup, dedup)
├── frontend/                    # Modern React + Tailwind v4 Web Application
│   ├── src/
│   │   ├── components/          # UploadZone, FileList, MultipartModal, Header
│   │   ├── hooks/               # useAuth, useFiles, useUpload
│   │   ├── services/            # API client and direct-to-S3 uploaders
│   │   └── types/               # TypeScript interfaces for files and user profiles
│   └── vite.config.ts           # Vite dev config with API reverse proxy
├── infra/
│   └── docker/                  # Nginx configuration, DynamoDB table init, LocalStack setup
├── docs/
│   ├── PROJECT_DOCUMENTATION.md # Comprehensive end-to-end system manual
│   ├── architecture.md          # In-depth architectural diagrams and decision explanations
│   ├── api.md                   # Complete REST endpoint contract reference
│   ├── decisions.md             # Architecture Decision Records (ADRs)
│   └── failure-scenarios.md     # Observed failure behavior matrix
├── tests/
│   ├── failure/                 # Crash tolerance documentation
│   └── load/                    # crash-tolerance.sh mid-traffic node failure demo
├── docker-compose.yml           # Complete local dev cluster orchestrator
├── .env.example                 # Root environment variable template
└── README.md
```

---

## Getting Started & Local Setup

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2+
- [Node.js](https://nodejs.org/) 20+ (optional, for running local unit tests)

### 1. Launch the Infrastructure
```bash
# Clone the repository
git clone https://github.com/rajanayak/distributed-file-storage.git
cd distributed-file-storage

# Initialize environment variables
cp .env.example .env

# Build and start all 9 containers in background
docker compose up --build -d
```

### 2. Verify Cluster Health
```bash
curl http://localhost:3000/ready
```
Expected response:
```json
{
  "status": "ready",
  "checks": {
    "dynamodb": "connected",
    "s3": "connected",
    "redis": "connected"
  }
}
```

### 3. Open the Dashboard
Navigate to [**http://localhost:5173**](http://localhost:5173) in your browser:
1. Register a test account (`alice@example.com` / `password123`).
2. Drag and drop files to trigger direct-to-S3 uploads.
3. For large files (>100MB), launch the Multipart Upload Manager to observe parallel chunk processing.

---

## Terminal Quickstart (cURL Walkthrough)

You can exercise the entire direct-to-S3 upload lifecycle directly from your terminal:

### Step 1: Register a User & Acquire JWT
```bash
AUTH_RESP=$(curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"securepassword123"}')

TOKEN=$(echo $AUTH_RESP | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)
echo "JWT Token: $TOKEN"
```

### Step 2: Request a Presigned Upload Reservation
```bash
# Create a sample payload file
echo "Distributed systems in action!" > sample.txt
SIZE=$(wc -c < sample.txt | tr -d ' ')

UPLOAD_INIT=$(curl -s -X POST http://localhost:3000/uploads \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"sample.txt\",\"fileSize\":$SIZE,\"mimeType\":\"text/plain\"}")

FILE_ID=$(echo $UPLOAD_INIT | grep -o '"fileId":"[^"]*' | cut -d'"' -f4)
UPLOAD_URL=$(echo $UPLOAD_INIT | grep -o '"uploadUrl":"[^"]*' | cut -d'"' -f4)
echo "File ID: $FILE_ID"
```

### Step 3: Stream File Directly to S3 (Zero API I/O)
```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: text/plain" \
  --upload-file sample.txt
```

### Step 4: Complete Upload & Trigger Background Verification
```bash
curl -s -X POST "http://localhost:3000/uploads/$FILE_ID/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

### Step 5: Verify Metadata & Fetch Presigned Download URL
```bash
# View metadata (status: COMPLETED, contentHash, refCount)
curl -s -X GET "http://localhost:3000/files/$FILE_ID" \
  -H "Authorization: Bearer $TOKEN"

# Acquire presigned download URL
curl -s -X GET "http://localhost:3000/files/$FILE_ID/download" \
  -H "Authorization: Bearer $TOKEN"
```

### Step 6: Test Distributed Rate Limiting & Idempotency
```bash
# Test Idempotency: Replaying with identical key returns cached response
curl -i -X POST http://localhost:3000/uploads \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: my-unique-req-123" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"sample.txt\",\"fileSize\":$SIZE,\"mimeType\":\"text/plain\"}"

# Inspect rate-limit headers in response:
# X-RateLimit-Limit: 30
# X-RateLimit-Remaining: 29
# X-RateLimit-Reset: 1718000000
```

---

## Storage Deduplication in Action

The system automatically detects identical files across uploads and eliminates redundant storage:

1. **First Upload**: User uploads `report.pdf`. Worker computes SHA-256 hash `e3b0c44...`, saves it to DynamoDB with `refCount = 1`, and retains the S3 object.
2. **Duplicate Upload**: User uploads `copy_of_report.pdf` (identical content). Worker computes matching SHA-256 hash `e3b0c44...`, locates the existing file via `ContentHashIndex` GSI, increments the canonical file's `refCount` to `2`, links the record's `s3Key`, and **purges the redundant S3 object**.
3. **Deletion**: When the first file is deleted, `refCount` decrements to `1` and the S3 blob is retained. Only when `refCount` reaches `0` is the physical object deleted from S3.

---

## API Quick Reference

Base URL: `http://localhost:3000`

### Authentication Endpoints
| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/auth/register` | Register new user; returns JWT access + refresh tokens | No |
| `POST` | `/auth/login` | Authenticate; returns JWT access + refresh tokens | No |
| `POST` | `/auth/refresh` | Exchange refresh token for fresh access token | No |

### File & Upload Endpoints
Protected with `Authorization: Bearer <accessToken>`.

| Method | Endpoint | Description | Key Query / Headers |
| :--- | :--- | :--- | :--- |
| `POST` | `/uploads` | Initiate presigned upload reservation | `Idempotency-Key` (optional) |
| `POST` | `/uploads/:id/complete` | Complete upload and trigger S3 verification | `Idempotency-Key` (optional) |
| `POST` | `/uploads/multipart/initiate` | Initiate S3 multipart session | `{ filename, fileSize, mimeType }` |
| `POST` | `/uploads/multipart/:id/parts` | Batch-generate presigned part URLs | `{ partNumbers: [1, 2, ...] }` |
| `POST` | `/uploads/multipart/:id/complete` | Submit part ETags and finalize upload | `{ parts: [{ PartNumber, ETag }] }` |
| `POST` | `/uploads/multipart/:id/abort` | Abort multipart session and clean parts | |
| `GET` | `/files` | List user's files with cursor pagination | `?limit=20&cursor=...` |
| `GET` | `/files/:id` | Fetch metadata for a specific file | |
| `GET` | `/files/:id/download` | Generate time-limited presigned download URL | Returns `{ downloadUrl, expiresIn }` |
| `DELETE`| `/files/:id` | Idempotent delete (decrements refCount, deletes S3) | Returns 204 No Content |
| `POST` | `/files/:id/retry` | Re-open failed or stalled upload | Returns fresh presigned upload URL |

### Health & Monitoring
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Liveness probe (HTTP 200 if container process is running) |
| `GET` | `/ready` | Readiness probe (verifies S3, DynamoDB, and Redis connectivity) |

---

## Resilience & Failure Matrix

| Failure Mode | Detection Mechanism | System Recovery Behavior |
| :--- | :--- | :--- |
| **API Replica Crash** | Nginx upstream health monitor (`/ready`) | Traffic automatically rerouted to remaining healthy replicas in <1s. Zero dropped requests. |
| **Worker Process Crash** | SQS visibility timeout expiration (300s) | Unacknowledged messages redelivered to alternative worker replicas. |
| **Poison Queue Message** | SQS Dead-Letter Queue (`maxReceiveCount = 5`) | Poison pill routed to `file-processing-dlq`; main queue unblocked. Inspectable via CLI. |
| **Network Disconnect Mid-Upload** | Upload status remains `INITIATED` / `UPLOADING` | Client can invoke `POST /files/:id/retry` or hourly cron marks upload `FAILED` after 24h. |
| **S3/DynamoDB Drift (Ghost Record)**| 15-minute reconciliation cron | Checks S3 for `COMPLETED` records; marks missing objects `FAILED` with operator alerts. |
| **Orphan S3 Objects** | 15-minute reconciliation cron | Purges S3 blobs lacking DynamoDB metadata (after 2h grace period). |
| **Concurrent Mutation Requests** | DynamoDB conditional expression on `IdempotencyKeys` | In-flight collision returns `409 Conflict`; completed replay returns original cached response. |

---

## Testing & Resilience Verification

### Running Automated Test Suites
The codebase includes 119 automated tests across unit, integration, and failure domains:

```bash
# 1. API Test Suite (92 tests across 17 suites)
cd apps/api
npm test

# 2. Worker Test Suite (27 tests across 8 suites)
cd apps/worker
npm test
```

### Chaos Engineering: Mid-Flight Node Failure Demo
Validate Nginx load balancer failover under active load:
```bash
bash tests/load/crash-tolerance.sh
```
**Test Behavior**:
1. Sends 40 continuous upload-initiation requests through Nginx (`http://localhost:3000`).
2. Abruptly kills container `api-2` during request 15.
3. Asserts that **100% of requests succeed** (`200/201`) via `api-1` and `api-3` without dropped packets or data corruption.

### Dead-Letter Queue Inspection
To inspect poisoned or failing messages quarantined in `file-processing-dlq`:
```bash
cd apps/worker
npm run inspect-dlq
```

---

## Environment Configuration

Key configuration parameters (defined in `.env`):

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `API_PORT` | `3000` | Host port exposed by Nginx reverse proxy |
| `FRONTEND_PORT` | `5173` | Host port exposed by React web dashboard |
| `S3_BUCKET` | `file-storage-dev` | AWS S3 bucket name |
| `PRESIGNED_PUT_EXPIRY_SECONDS` | `900` | Expiration window for presigned upload URLs (15m) |
| `PRESIGNED_GET_EXPIRY_SECONDS` | `300` | Expiration window for presigned download URLs (5m) |
| `MAX_FILE_SIZE_BYTES` | `5368709120` | Maximum allowable single upload size (5 GB) |
| `RATE_LIMIT_MAX` | `30` | Maximum requests allowed per rate limit window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit sliding window duration (60s) |
| `CLEANUP_CRON_SCHEDULE` | `0 * * * *` | Cron schedule for abandoned upload cleanup (hourly) |
| `RECONCILIATION_CRON_SCHEDULE`| `*/15 * * * *` | Cron schedule for two-way storage reconciliation |

---

## Troubleshooting & Operations

### 1. Port Conflicts
If ports `3000`, `5173`, `8000`, `4566`, or `6379` are occupied on your host, edit `.env`:
```bash
API_PORT=3001
FRONTEND_PORT=5174
```

### 2. View Real-Time Container Logs
```bash
# Stream API replica logs
docker compose logs -f api-1

# Stream background worker logs
docker compose logs -f worker-1
```

### 3. Complete Reset of Local Cluster State
To purge all DynamoDB records, S3 objects, SQS messages, and Redis cache:
```bash
docker compose down -v
docker compose up --build -d
```

---

## Documentation Index

Detailed specifications and architectural documentation are available in the [`docs/`](docs/) directory:

- [**Complete Project Documentation (`PROJECT_DOCUMENTATION.md`)**](docs/PROJECT_DOCUMENTATION.md): Comprehensive system manual detailing architecture, data models, state machines, deduplication mechanics, and operation guides.
- [**Architecture Deep Dive (`architecture.md`)**](docs/architecture.md): In-depth diagrams, failure domain boundaries, and trade-off analyses.
- [**REST API Specifications (`api.md`)**](docs/api.md): Full HTTP contracts, payload schemas, error structures, and header requirements.
- [**Architecture Decision Records (`decisions.md`)**](docs/decisions.md): Formal record of architectural decisions (ADRs), constraints, and evaluated alternatives.
- [**Failure Scenarios Matrix (`failure-scenarios.md`)**](docs/failure-scenarios.md): Comprehensive matrix of potential failure modes, detection mechanisms, and recovery behavior.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
