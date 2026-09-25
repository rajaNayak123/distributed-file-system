# Distributed File Storage System — Complete Project Documentation

## 1. Executive Summary & Problem Statement

### 1.1 Motivation & Context
Traditional file upload implementations in web backends typically stream file bytes directly through the application server (e.g., via Express middleware such as `multer` or `formidable`) and write them to the host's local filesystem. While this approach suffices for basic prototypes, it introduces severe architectural bottlenecks and failure modes in production:

1. **Statefulness & Scaling Bottlenecks**: Instances bound to local disk storage cannot scale horizontally behind a load balancer without a shared network filesystem (NFS/EFS), which quickly becomes a single point of failure and I/O bottleneck.
2. **Server Resource Starvation**: High-throughput binary streams consume server sockets, event-loop cycles, and memory buffers, choking standard HTTP API requests.
3. **Partial Failure & Abandoned Data**: Network disconnects during large uploads leave incomplete files on disk with no cleanup mechanism or state tracking.
4. **Data Inconsistency**: Without an explicit state machine and reconciliation loop, object storage metadata and database records inevitably drift out of sync.

### 1.2 System Objectives
The **Distributed File Storage System** is a distributed, cloud-native file storage platform inspired by architectures like Dropbox and Google Drive. It decouples API coordination from binary data transport by utilizing:
- **Direct-to-Object-Storage Transfers** via AWS S3 Presigned URLs (Zero API disk writes).
- **Stateless Horizontally Scaled API Replicas** fronted by an Nginx reverse proxy.
- **Strict Upload Lifecycle State Machines** tracked in DynamoDB.
- **Content-Addressed Storage Deduplication** to minimize storage overhead.
- **Asynchronous Event-Driven Processing** via AWS SQS and background worker fleets.
- **Two-Way Background Reconciliation** to purge orphan objects and reconcile corrupted records.
- **Distributed Shared-State Rate Limiting** with Redis.
- **Full Idempotency Guarantees** protecting against duplicate mutations and network retries.

---

## 2. System Architecture & Topology

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

### 2.1 Infrastructure Components
| Component | Technology | Role | Port |
| :--- | :--- | :--- | :--- |
| **Edge Load Balancer** | Nginx Alpine | Round-robin reverse proxy, active health probing (`/ready`), SSL termination proxy | `3000` |
| **API Cluster** | Node.js (Express, ES Modules) | 3 stateless replicas (`api-1`, `api-2`, `api-3`), auth, presigning, metadata management | Internal |
| **Database** | DynamoDB Local | Persistent metadata store (`Users`, `Files`, `IdempotencyKeys`) with GSI secondary indexes | `8000` |
| **Object Store** | LocalStack S3 | Durable blob store (`file-storage-dev` bucket) | `4566` |
| **Message Queue** | LocalStack SQS | Asynchronous job distribution (`file-processing-queue`, `file-processing-dlq`) | `4566` |
| **Distributed Cache** | Redis 7 Alpine | Atomic sliding-window rate limit counters across replicas | `6379` |
| **Worker Cluster** | Node.js Worker | 2 background replicas (`worker-1`, `worker-2`), async checksumming, deduplication, crons | Internal |
| **Web Dashboard** | React + Tailwind v4 + Vite | Single-page application with direct S3 upload & multipart management | `5173` |

---

## 3. Core Subsystems & Mechanisms

### 3.1 Direct-to-Storage Upload Architecture
To ensure zero local disk utilization on API servers, file transfers never traverse the API process:
1. The client requests an upload reservation via `POST /uploads` (specifying file name, size, MIME type).
2. The API validates parameters, creates a file record in DynamoDB with status `INITIATED`, generates an S3 Presigned `PUT` URL (configured with a 15-minute TTL), and returns it to the client.
3. The client uploads the binary payload directly to S3 via HTTP `PUT`.
4. Upon transfer completion, the client invokes `POST /uploads/:id/complete`.
5. The API performs an S3 `HeadObject` command to verify that the file actually exists in S3 and its byte size matches the registered size.
6. The API transitions the file status to `COMPLETED` and publishes a `FILE_UPLOADED` event to SQS.

### 3.2 S3 Multipart Uploads for Large Files
For files exceeding 100MB (or up to multi-gigabyte limits), single `PUT` requests are vulnerable to connection resets. The system implements S3 Multipart Upload orchestration:
1. **Initiate**: `POST /uploads/multipart/initiate` calls S3 `CreateMultipartUpload` and creates an `INITIATED` record in DynamoDB storing `s3UploadId`.
2. **Presigned Part URLs**: `POST /uploads/multipart/:id/parts` accepts part numbers and returns batch presigned `PUT` URLs containing the `partNumber` and `uploadId` query parameters.
3. **Parallel Uploading**: Clients can upload parts concurrently directly to S3 and collect `{ PartNumber, ETag }` responses.
4. **Complete**: `POST /uploads/multipart/:id/complete` submits the array of parts to S3 `CompleteMultipartUpload`. The API verifies object completion and sets status to `COMPLETED`.
5. **Abort & Cleanup**: `POST /uploads/multipart/:id/abort` cancels the upload in S3 and marks DynamoDB status as `FAILED`. An automated background cron cleans up abandoned multipart parts after 24 hours.

### 3.3 File Lifecycle State Machine
File states transition through a deterministic lifecycle:
```
           ┌─────────────┐
           │  INITIATED  │
           └──────┬──────┘
                  │ Client starts upload
                  ▼
           ┌─────────────┐
           │  UPLOADING  │
           └──────┬──────┘
                  │ Client signals completion
                  ▼
           ┌─────────────┐
           │ COMPLETING  │
           └──────┬──────┘
                  │ Verification (HeadObject)
         ┌────────┴────────┐
         │                 │
      Success           Failure / Timeout
         ▼                 ▼
  ┌─────────────┐   ┌─────────────┐
  │  COMPLETED  │   │   FAILED    │
  └─────────────┘   └─────────────┘
```

- Invalid transitions (e.g. attempting to complete an already `COMPLETED` or `FAILED` file) are rejected with `409 Conflict`.
- Files remaining in non-terminal states beyond the cutoff window (24 hours) are picked up by the cleanup processor.

### 3.4 Content-Addressed Storage Deduplication
To optimize storage costs and eliminate duplicate S3 storage:
1. When an upload completes, the worker streams the file from S3 to compute its cryptographic SHA-256 hash.
2. The worker checks DynamoDB's `ContentHashIndex` Global Secondary Index (GSI) to determine if an identical hash already exists in another `COMPLETED` file.
3. **If unique**:
   - The file's `contentHash` is saved, and `refCount` is initialized to `1`.
4. **If duplicate**:
   - The new file's `s3Key` is pointed to the existing file's canonical S3 key.
   - The redundant newly uploaded S3 object is purged.
   - The existing canonical object's `refCount` is atomically incremented (`ADD refCount :inc`).
5. **On Deletion**:
   - When a user deletes a file, the API inspects `refCount`.
   - If `refCount > 1`, `refCount` is decremented by 1; the physical S3 object is preserved.
   - If `refCount <= 1`, the physical S3 object is permanently deleted from the bucket.

### 3.5 Asynchronous Worker Pipeline & DLQ
Background work is completely decoupled from the synchronous HTTP request path:
- **Long-Polling SQS Consumer**: Workers consume `FILE_UPLOADED` messages using SQS long polling (WaitTimeSeconds = 20) with a 300-second visibility timeout.
- **Non-Ack on Failure**: If processing throws an unexpected error, the message is not deleted from SQS. Once the visibility timeout lapses, SQS redelivers the message to another worker instance.
- **Dead-Letter Queue (DLQ)**: Configured with `maxReceiveCount = 5`. Messages failing 5 consecutive attempts are routed to `file-processing-dlq` to prevent poison pills from blocking the pipeline.
- **CLI Inspection**: Operators can inspect, retry, or purge failed messages using `npm run inspect-dlq` in `apps/worker`.

### 3.6 Two-Way Automated Reconciliation
In distributed cloud storage, network partitions or process crashes can cause drift between metadata and object storage. The worker executes an automated reconciliation loop every 15 minutes:
- **Case A (Database Ghost Records)**: DynamoDB records marked `COMPLETED` whose corresponding S3 object is missing or unreadable are transitioned to `FAILED` with an alert logged.
- **Case B (S3 Orphan Objects)**: Objects in S3 that have no corresponding record in DynamoDB (and were created more than 2 hours ago to prevent racing active uploads) are automatically purged from S3.

### 3.7 Distributed Rate Limiting
To protect the API fleet against denial-of-service and brute-force abuse across all 3 stateless replicas:
- Backed by an in-memory Redis cluster.
- Implements a sliding window per IP address or authenticated user.
- Emits standard RFC-compliant HTTP headers on all responses:
  - `X-RateLimit-Limit`: Maximum requests allowed in current window.
  - `X-RateLimit-Remaining`: Remaining allowance.
  - `X-RateLimit-Reset`: Unix epoch timestamp when quota resets.
- When quota is exceeded, returns `429 Too Many Requests` with a `Retry-After: <seconds>` header.

### 3.8 Idempotency & Fault-Tolerant Retries
- **Idempotency Keys**: Mutation endpoints (`POST /uploads`, `POST /uploads/:id/complete`) support the `Idempotency-Key` header.
- **Concurrency Locking**: If a concurrent duplicate request arrives while the first is in-flight, the API returns `409 Conflict`.
- **Payload Verification**: If an existing key is presented with a different payload, the API returns `422 Unprocessable Entity`.
- **Cached Replay**: If an existing key is presented after successful completion, the API returns the cached response without re-executing logic.
- **Exponential Backoff**: AWS SDK calls utilize custom `NodeHttpHandler` configurations with connection timeouts (3s), socket timeouts (5s), and exponential backoff with decorrelated full jitter.

---

## 4. Data Models & Database Schemas

The system uses Amazon DynamoDB with single-attribute primary keys and Global Secondary Indexes (GSIs).

### 4.1 `Files` Table
Primary Key: `fileId` (String, UUID v4)

| Attribute | Type | Description |
| :--- | :--- | :--- |
| `fileId` | String (PK) | Unique identifier of the file |
| `userId` | String | Owner identifier (foreign key to `Users`) |
| `filename` | String | Original client filename |
| `fileSize` | Number | Size in bytes |
| `mimeType` | String | MIME type (e.g., `image/png`, `application/pdf`) |
| `status` | String | `INITIATED`, `UPLOADING`, `COMPLETING`, `COMPLETED`, `FAILED` |
| `s3Key` | String | Storage key path in S3 bucket |
| `s3UploadId` | String | S3 multipart upload ID (if multipart) |
| `contentHash` | String | SHA-256 cryptographic digest of file contents |
| `refCount` | Number | Reference count for content deduplication |
| `createdAt` | String | ISO 8601 creation timestamp |
| `updatedAt` | String | ISO 8601 last modified timestamp |

**Global Secondary Indexes (GSI):**
1. `UserIdIndex`: Partition Key `userId` — enables querying all files owned by a specific user.
2. `ContentHashIndex`: Partition Key `contentHash` — enables deduplication lookup across files.

### 4.2 `Users` Table
Primary Key: `userId` (String, UUID v4)

| Attribute | Type | Description |
| :--- | :--- | :--- |
| `userId` | String (PK) | Unique identifier of the user |
| `email` | String | User's unique email address |
| `passwordHash` | String | Scrypt/bcrypt hashed password |
| `createdAt` | String | ISO 8601 creation timestamp |

**Global Secondary Indexes (GSI):**
1. `EmailIndex`: Partition Key `email` — used during authentication to look up users by email.

### 4.3 `IdempotencyKeys` Table
Primary Key: `key` (String)

| Attribute | Type | Description |
| :--- | :--- | :--- |
| `key` | String (PK) | Scoped idempotency key (`userId#key` or `clientKey`) |
| `requestHash` | String | SHA-256 hash of the request parameters |
| `status` | String | `IN_FLIGHT` or `RESOLVED` |
| `statusCode` | Number | Cached HTTP response status code (e.g., 200, 201) |
| `responseBody`| String | Serialized JSON response body to replay |
| `expiresAt` | Number | Unix epoch timestamp for DynamoDB TTL automatic expiration |

---

## 5. REST API Specifications

Base URL: `http://localhost:3000`

### 5.1 Authentication Endpoints
- `POST /auth/register`: Create a new user account. Returns `{ accessToken, refreshToken, user }`.
- `POST /auth/login`: Authenticate with email/password. Returns `{ accessToken, refreshToken, user }`.
- `POST /auth/refresh`: Exchange a valid refresh token for a new access token.

### 5.2 File Management Endpoints
All file endpoints require `Authorization: Bearer <accessToken>`.

| Method | Path | Description | Key Headers / Params |
| :--- | :--- | :--- | :--- |
| `POST` | `/uploads` | Initiate a single presigned upload | `Idempotency-Key` (optional) |
| `POST` | `/uploads/:id/complete` | Complete single upload and trigger verification | `Idempotency-Key` (optional) |
| `POST` | `/uploads/multipart/initiate` | Initiate S3 multipart upload session | Body: `{ filename, fileSize, mimeType }` |
| `POST` | `/uploads/multipart/:id/parts` | Generate batch presigned URLs for part chunks | Body: `{ partNumbers: [1, 2, ...] }` |
| `POST` | `/uploads/multipart/:id/complete` | Finalize multipart upload with part ETags | Body: `{ parts: [{ PartNumber, ETag }] }` |
| `POST` | `/uploads/multipart/:id/abort` | Abort multipart upload session | |
| `GET` | `/files` | List all files belonging to authenticated user | Pagination query: `?limit=20&cursor=...` |
| `GET` | `/files/:id` | Get metadata for a specific file | |
| `GET` | `/files/:id/download` | Generate secure presigned S3 download URL | Returns `{ downloadUrl, expiresIn }` |
| `DELETE` | `/files/:id` | Idempotent delete (decrements refCount, deletes S3) | Returns 204 No Content |
| `POST` | `/files/:id/retry` | Re-open failed or stalled upload | Returns refreshed presigned upload URL |

### 5.3 System & Observability Endpoints
- `GET /health`: Liveness probe for individual API instances (always returns 200 if process is running).
- `GET /ready`: Readiness probe verifying downstream connectivity to S3, DynamoDB, and Redis. Nginx uses this to remove degraded instances from the round-robin pool.

---

## 6. Frontend Dashboard (React + Tailwind v4)

Located in `frontend/`, the web dashboard provides an interactive user experience:
- **Authentication Flow**: User registration and login forms with persistent JWT storage and automatic token refresh.
- **Direct S3 Upload Client**: Browser-side file picker that invokes `POST /uploads`, streams the file to S3 using `XMLHttpRequest` (exposing real-time upload speed and progress bar), and confirms completion.
- **Large File Multipart Upload Manager**: Client-side chunker that partitions files into 5MB slices, acquires part presigned URLs, and uploads chunks concurrently with retry capability.
- **File Library**: Data grid displaying file name, size, MIME type, upload status badges (`COMPLETED`, `UPLOADING`, `FAILED`), and deduplication indicators.
- **Secure Download**: Direct download trigger leveraging S3 presigned download URLs.
- **System Health Monitor**: Live indicator displaying backend replica readiness and cluster status.

---

## 7. Verification, Testing & Resilience

### 7.1 Automated Test Suites
The repository contains 100+ automated unit, integration, and failure tests:

```bash
# Run API test suite (92 tests across 17 suites)
cd apps/api
npm test

# Run Worker test suite (27 tests across 8 suites)
cd apps/worker
npm test
```

Key test categories:
- **Static Analysis Guard**: Asserts zero file-system write calls (`fs.writeFile`, `fs.createWriteStream`, etc.) in the entire API codebase.
- **State Machine Integrity**: Validates transitions and prevents duplicate completions or illegal state jumps.
- **Deduplication Logic**: Asserts that uploading duplicate payloads links S3 keys and prevents redundant storage consumption.
- **DLQ Redelivery**: Simulates processing errors and validates message quarantine after 5 attempts.

### 7.2 Mid-Flight Chaos & Crash Tolerance Demo
The system includes an automated chaos test demonstrating Nginx zero-downtime failover:
```bash
bash tests/load/crash-tolerance.sh
```
1. Fires 40 sequential file upload initiation requests through Nginx (`http://localhost:3000`).
2. Kills container `api-2` abruptly during request 15.
3. Asserts that 100% of requests succeed with `200/201` responses via `api-1` and `api-3` without dropped requests or data corruption.

### 7.3 Dead Letter Queue Inspection
When troubleshooting failed worker tasks:
```bash
cd apps/worker
npm run inspect-dlq
```
Outputs count, message IDs, payload details, error stack traces, and provides options to redrive or purge poisoned messages.

---

## 8. Deployment & Local Operations

### 8.1 Prerequisites
- Docker Engine 24+ & Docker Compose v2+
- Node.js 20+ (for local CLI scripts and testing)

### 8.2 One-Command Bootstrap
```bash
# 1. Clone repository and navigate to root
cd distributed-file-storage

# 2. Configure environment variables
cp .env.example .env

# 3. Start complete cluster in background
docker compose up --build -d
```

### 8.3 Verifying Cluster Status
```bash
# Check load balancer readiness
curl http://localhost:3000/ready

# Check running Docker containers
docker compose ps
```

All 9 containers should show healthy/running:
- `nginx`
- `api-1`, `api-2`, `api-3`
- `worker-1`, `worker-2`
- `dynamodb-local`
- `localstack`
- `redis`
- `frontend`

Access the web interface at `http://localhost:5173`.
