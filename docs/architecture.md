# Architecture (through Phase 7)

## Component responsibilities

| Component | Responsibility | Never does |
|---|---|---|
| API (Express) | AuthN/AuthZ, validation, orchestrates S3/DynamoDB calls, issues presigned URLs, enforces rate limits | Store file bytes, trust client-supplied keys/ownership |
| S3 (LocalStack locally / AWS S3 in prod) | Owns file bytes | Know about users/ownership (that's enforced one layer up) |
| DynamoDB (DynamoDB Local locally / AWS DynamoDB in prod) | Owns file/user metadata, upload state, and ContentHashIndex GSI | Store file bytes |
| Redis (Redis 7 locally / AWS ElastiCache in prod) | Shared atomic sliding/fixed window state for cross-instance rate limiting | Store persistent business data or file metadata |
| Worker (Node.js) | SQS consumer (checksum, metadata validation, deduplication) and cron tasks (abandoned upload cleanup, reconciliation) | Serve direct synchronous HTTP requests |
| Client | Talks directly to S3 via presigned URLs for upload/download | Talk to the API for bytes |
| nginx (local) / ALB (prod) | Load-balances traffic across API replicas; routes around unhealthy instances | Know anything about business logic |

## Upload sequence (Phase 2)

```
Client                         API                              S3               DynamoDB
  |                              |                                |                   |
  |--POST /uploads (meta)------->|                                |                   |
  |                              |--putItem status=INITIATED----------------------------->|
  |                              |--getPresignedPutUrl---------->|                   |
  |                              |<--presigned PUT URL-----------|                   |
  |                              |--updateItem status=UPLOADING-------------------------->|
  |<--{uploadId,fileId,url}------|                                |                   |
  |                                                                |                   |
  |--PUT <bytes> directly to presignedUrl------------------------>|                   |
  |<--200 OK (from S3, not the API)-------------------------------|                   |
  |                                                                |                   |
  |--POST /uploads/:id/complete->|                                |                   |
  |                              |--updateItem status=COMPLETING------------------------->|
  |                              |--HeadObject------------------>|                   |
  |                              |<--exists / not found----------|                   |
  |                              |--updateItem status=COMPLETED or FAILED--------------->|
  |<--{status: COMPLETED|FAILED}-|                                |                   |
```

Key property: the API is on the request path for *metadata and authorization
decisions only*. The heaviest part of the operation — moving the actual bytes —
happens entirely between the client and S3, over a connection the API
authorized but is not a party to.

## Download sequence (Phase 2)

```
Client                         API                              S3
  |--GET /files/:id/download--->|
  |                              |--requireOwnedFile (DynamoDB, scoped by authenticated userId)
  |                              |--getPresignedGetUrl---------->|
  |                              |<--presigned GET URL-----------|
  |<--{downloadUrl,expiresAt}----|
  |
  |--GET <bytes> directly from downloadUrl----------------------->|
  |<--200 OK + bytes (from S3, not the API)------------------------|
```

## Why no server/instance owns any request's state

Every piece of information needed to serve a request — who the caller is (JWT,
verified per-request), what files they own (DynamoDB, queried per-request), and
where file bytes live (S3, addressed by a server-derived key stored in
DynamoDB) — is either recomputed from the request itself or fetched fresh from
a shared external store. No in-process cache, session, or local file backs any
of this. That's what makes **"any API instance can serve any request"** true.

This property was designed in Phase 2 and *demonstrated* in Phase 4 by running
three replicas behind a load balancer and stopping one mid-traffic.

## Upload state machine

```
INITIATED --> UPLOADING --> COMPLETING --> COMPLETED
     \             \              \
      \-> FAILED     \-> FAILED     \-> FAILED
```

See `docs/decisions.md` for why this shape was chosen over a boolean flag, and
`apps/api/src/utils/uploadStateMachine.js` for the enforced transition table.

## Health endpoints

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /health` | Liveness — is the process running? | Always `200 { status: "ok", instance: "<hostname>" }` |
| `GET /ready` | Readiness — can this instance reach its dependencies? | `200` when DynamoDB + S3 are reachable, `503` otherwise |

The load balancer polls `/ready` and stops routing to instances that return
non-200. In production this is the ALB target group health check path.

## Local dev topology (Phase 4)

```
                       ┌──────────────────────────────────────────┐
External traffic       │         docker-compose network           │
http://localhost:3000  │                                          │
        │              │   ┌─────────────────────────────────┐   │
        ▼              │   │  nginx (port 80 → host 3000)    │   │
  ┌──────────┐         │   │  round-robin + passive health   │   │
  │  nginx   │─────────┼──►│  ALB stand-in (see nginx.conf) │   │
  └──────────┘         │   └──────────┬──────────────────────┘   │
  Local stand-in       │              │ round-robin               │
  for AWS ALB          │    ┌─────────▼──────────────────┐       │
                       │    │   api-1   api-2   api-3    │       │
                       │    │  (port 3000, no host bind) │       │
                       │    └────┬──────────┬────────────┘       │
                       │         │          │                     │
                       │    ┌────▼──┐  ┌───▼──────────┐         │
                       │    │  DDB  │  │  LocalStack  │         │
                       │    │ Local │  │  (S3 + SQS)  │         │
                       │    └───────┘  └──────────────┘         │
                       └──────────────────────────────────────────┘
```

**How a request flows:**

1. Client calls `http://localhost:3000/uploads` (any endpoint).
2. nginx receives it and picks the next upstream (round-robin).
3. The selected API replica verifies the JWT, queries DynamoDB, and
   generates an S3 presigned URL — all from shared external stores.
4. Response returns through nginx to the client.

If the selected replica is down, nginx detects the failure
(`max_fails=3 fail_timeout=30s`) and routes to one of the other two.
**No request state is lost** because nothing about the request lived in
the failed instance's memory.

### Production equivalent mapping

| Local (Phase 4) | AWS Production |
|---|---|
| nginx container | AWS Application Load Balancer (ALB) |
| round-robin | ALB round-robin target group |
| `max_fails=3 fail_timeout=30s` | ALB health check: 3 × unhealthy threshold |
| `GET /ready` health check | ALB target group health check path: `/ready` |
| `docker stop dfs-api-2` | ECS task crash / EC2 instance termination |
| 3 containers on 1 host | 3 ECS tasks across 3 Availability Zones |
| DynamoDB Local | AWS DynamoDB |
| LocalStack S3 | AWS S3 |

### Phase 4 topology (earlier phases)

```
docker-compose (Phase 1/2)
 ├── localstack        (S3 + SQS emulation; SQS unused until Phase 6)
 ├── dynamodb-local     (DynamoDB Local)
 ├── dynamodb-init      (one-shot: creates Files/Users tables + EmailIndex GSI, then exits)
 └── api                (Express, port 3000)
```

Phase 4 replaces the single `api` service with `api-1`, `api-2`, `api-3`
plus the `nginx` load balancer. The mock dependency services are unchanged.

## Crash-tolerance demo (Phase 4)

Run `bash tests/load/crash-tolerance.sh` to exercise the crash-tolerance
scenario. See `tests/failure/crash-tolerance.md` for the full walkthrough,
expected output, and a mapping to production failure modes.

The demo fires 40 requests, stops `api-2` after request 15, and verifies
all 40 succeed. It is the "strong demo" referenced in the Phase 4 blueprint.

## Phase 6: Event-Driven Processing (SQS + Worker)

### What moved off the request path

| Concern | Phase 5 (on request path) | Phase 6 (off request path) |
|---|---|---|
| Checksum computation | ❌ Not done | ✅ Worker — `checksum.processor.js` |
| Content-type validation | ❌ Not done | ✅ Worker — `metadata.processor.js` |
| Abandoned upload cleanup | ⚠️ API cron (`server.js`) | ✅ Worker — `cleanup.processor.js` |
| Reconciliation | ❌ Not done | 🔜 Stubbed — Phase 7 |

### Phase 6 topology

```
                       ┌────────────────────────────────────────────┐
External traffic       │          docker-compose network            │
http://localhost:3000  │                                            │
        │              │   ┌─────────────────────────────────────┐  │
        ▼              │   │  nginx (port 80 → host 3000)        │  │
  ┌──────────┐         │   └──────────┬──────────────────────────┘  │
  │  nginx   │─────────┼─────────────►│ round-robin                 │
  └──────────┘         │    ┌─────────▼──────────────────┐         │
                       │    │   api-1   api-2   api-3    │         │
                       │    └──────┬──────────┬───────────┘         │
                       │           │          │                      │
                       │    ┌──────▼──┐  ┌────▼────────────────┐   │
                       │    │  DDB    │  │  LocalStack          │   │
                       │    │  Local  │  │  (S3 + SQS)         │   │
                       │    └─────────┘  └────────┬────────────┘   │
                       │                          │                 │
                       │              file-processing-queue         │
                       │                 (maxReceiveCount=5)        │
                       │                          │                 │
                       │        ┌─────────────────▼──────────────┐  │
                       │        │  worker-1        worker-2       │  │
                       │        │  (long-poll consumer + cron)   │  │
                       │        └────────────────────────────────┘  │
                       │                          │ on failure       │
                       │              file-processing-dlq           │
                       └────────────────────────────────────────────┘
```

### Upload completion → SQS → worker flow

```
Client            API                     SQS                  Worker            DynamoDB / S3
  |                |                        |                      |                   |
  |--POST /uploads/:id/complete------------>|                      |                   |
  |                |--HeadObject--------------------------------------------->S3       |
  |                |<--exists, size, etag---------------------------------------------|
  |                |--updateFileStatus(COMPLETED)----------------------------->DDB      |
  |                |--SendMessage(FILE_UPLOADED)----->|                        |        |
  |                |  [fire-and-forget;               |                        |        |
  |                |   error logged, not thrown]      |                        |        |
  |<--{status:COMPLETED}-|                            |                        |        |
  |                      |                            |                        |        |
  |                      |      [async, off req path] |                        |        |
  |                      |                            |--ReceiveMessage------->|        |
  |                      |                            |<-FILE_UPLOADED---------|        |
  |                      |                            |                        |--GetObject->S3
  |                      |                            |                        |<--stream---|
  |                      |                            |                        |--SHA-256---|
  |                      |                            |                        |--updateChecksum->DDB
  |                      |                            |                        |--HeadObject->S3
  |                      |                            |                        |--[log if mismatch]
  |                      |                            |<--DeleteMessage--------|
```

### Worker failure handling

```
Processor throws
    │
    ├─ DO NOT call DeleteMessage
    │   └─ Message stays in-flight
    │        └─ Visible again after visibility timeout (300s)
    │             └─ Another worker (or same after restart) picks it up
    │
    └─ SQS tracks ApproximateReceiveCount
         └─ After maxReceiveCount (5) → auto-moved to file-processing-dlq
              └─ Inspect with: npm run inspect-dlq
```

### Horizontal scalability

Running two worker replicas (`worker-1`, `worker-2`) on the same queue is safe
because:

1. **SQS visibility timeout** prevents two workers from processing the same
   message simultaneously — once a worker receives a message, it's invisible
   to other consumers for 300s.
2. **updateChecksum uses a conditional expression** (`attribute_exists(PK)`)
   — if two workers somehow both receive the same message, the second write is
   idempotent (same checksum value, no harm done).
3. **Cleanup cron** uses `ConditionalCheckFailedException`-safe DynamoDB
   expressions — concurrent cleanup runs are harmless.

In production, this maps to N ECS tasks or Lambda concurrency all reading
from the same SQS queue.

## Phase 7: Advanced Features (Reconciliation, Deduplication, and Shared Rate Limiting)

### Phase 7 topology

```
                       ┌───────────────────────────────────────────────────────────┐
External traffic       │                  docker-compose network                   │
http://localhost:3000  │                                                           │
        │              │   ┌─────────────────────────────────────────────────┐     │
        ▼              │   │  nginx (port 80 → host 3000)                    │     │
  ┌──────────┐         │   │  round-robin + passive health (/ready)          │     │
  │  nginx   │─────────┼──►│  ALB stand-in (see nginx.conf)                  │     │
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

### 1. Reconciliation Loop & Consistency Gap Closure

#### The Architectural Problem: Non-Atomic Dual Writes
S3 and DynamoDB are distinct distributed storage systems with separate consensus domains and APIs. There is no distributed two-phase commit (2PC) between an S3 PUT/DELETE and a DynamoDB PutItem/DeleteItem. Even with deliberate write ordering, transient network partitions or process crashes create consistency gaps:

- **Case A (DynamoDB says exists, S3 object missing)**:
  - An upload record is left in `UPLOADING` or `COMPLETING`, or a record is falsely marked `COMPLETED` when the S3 object does not exist (e.g. client never uploaded bytes, PUT was aborted, or an S3 delete succeeded while the subsequent DynamoDB delete failed).
  - *Risk*: Users request downloads for nonexistent objects, resulting in 404/500 errors.
- **Case B (S3 object exists, DynamoDB record missing or failed)**:
  - An S3 object exists in the bucket, but its DynamoDB record was never created, is marked `FAILED`, or the DynamoDB delete succeeded while an earlier S3 delete failed.
  - *Risk*: Silent, ongoing storage cost accumulation from orphaned objects.

#### The Reconciliation Solution: Bounded Staleness
The reconciliation loop (`runReconciliation`) in `apps/worker` acts as an anti-entropy system bounding staleness to the configured cron interval (default: 15 minutes).

```
Reconciliation Loop (cron every 15m or SQS on-demand)
  │
  ├─► Case A: Scan DynamoDB for suspicious records:
  │     • status IN ('UPLOADING', 'COMPLETING') AND updatedAt < 30m ago
  │     • status = 'COMPLETED' AND checksum is null AND updatedAt < 15m ago
  │     │
  │     └─► For each suspicious item: S3 HeadObject(s3Key)
  │           ├─ Object MISSING (404 / NotFound)
  │           │    └─► updateFileStatus(toStatus: 'FAILED',
  │           │           failureReason: 'reconciliation: object missing')
  │           │        [Never silently left as COMPLETED]
  │           │
  │           └─ Object EXISTS in S3
  │                └─► If COMPLETED & missing checksum:
  │                      stream object, compute SHA-256, repair checksum
  │
  └─► Case B: Periodic S3 ListObjectsV2 sweep:
        │
        └─► For each S3 object:
              ├─ Object age < orphanGracePeriod (60m)
              │    └─► SKIP (guard against in-flight multipart/PUT uploads)
              │
              └─ Object age >= orphanGracePeriod (60m)
                   ├─ Parse key (users/<userId>/files/<fileId>)
                   ├─ Query DynamoDB GetFile(userId, fileId)
                   │    ├─ Item missing OR status = 'FAILED'
                   │    │    └─► DeleteObject(Key) from S3
                   │    │        [Log: reconciliation_case_b_orphan_deleted]
                   │    │
                   │    └─ Item exists & status = 'COMPLETED'
                   │         └─► Keep object (active file)
```

---

### 2. Content-Addressed Storage Deduplication

#### Cryptographic Collision Safety Model
Deduplication identifies identical content across users using SHA-256 hashes ($2^{256} \approx 1.15 \times 10^{77}$ states).
- By the **Birthday Paradox**, achieving a 50% probability of a single hash collision requires approximately $2^{128} \approx 3.4 \times 10^{38}$ distinct files.
- In a production system storing 1 billion ($10^9$) files, the collision probability is less than $10^{-59}$ — dozens of orders of magnitude lower than the uncorrectable DRAM bit-flip rate from cosmic rays ($10^{-14}$ per hour).
- Therefore, SHA-256 content hashing is mathematically sound for deduplication without requiring expensive byte-by-byte full stream comparison.

#### DynamoDB GSI: `ContentHashIndex`
To detect existing content without full table scans (which cost $O(N)$ RCUs and degrade as the dataset grows), we define the `ContentHashIndex` Global Secondary Index on the `Files` table:
- **Index Partition Key**: `contentHash` (String)
- **Projection**: `ALL`
- **Access Pattern**: Given a SHA-256 hash, retrieve all file records referencing this content in $O(1)$ time.

#### Deduplication Upload Flow

```
Client            API                     SQS                  Worker            DynamoDB / S3
  |                |                        |                      |                   |
  |--complete----->|                        |                      |                   |
  |                |--update(COMPLETED)---->|                      |                   |
  |                |--SendMessage---------->|                      |                   |
  |<--200 OK-------|                        |                      |                   |
  |                                         |--ReceiveMessage----->|                   |
  |                                         |<-FILE_UPLOADED-------|                   |
  |                                                                |--Stream & SHA-256->S3
  |                                                                |                   |
  |                                                                |--Query ContentHashIndex
  |                                                                |  (contentHash = digest)
  |                                                                |                   |
  |                                     ┌──────────────────────────┴──────────────────┐
  |                                     │ Match found?                                │
  |                                     ├──────────────────────┬──────────────────────┤
  |                                     │ NO (First upload)    │ YES (Duplicate file) │
  |                                     ├──────────────────────┼──────────────────────┤
  |                                     │ • isDedup: false     │ • isDedup: true      │
  |                                     │ • refCount: 1        │ • Point s3Key to     │
  |                                     │ • Store contentHash  │   canonical s3Key    │
  |                                     │ • Keep S3 object     │ • Incr canonical     │
  |                                     │                      │   refCount           │
  |                                     │                      │ • Delete redundant   │
  |                                     │                      │   uploaded S3 object │
  |                                     └──────────────────────┴──────────────────────┘
```

#### Dedup-Aware Deletion Semantics
Deleting files must respect reference counting so that shared objects are preserved until all references are gone:
1. **Deleting an alias (`isDedup: true`)**:
   - Decrements canonical object's `refCount`.
   - Deletes only the alias's DynamoDB record.
   - **Preserves S3 object**.
2. **Deleting a canonical file with `refCount > 1`**:
   - Other aliases still rely on this object.
   - Decrements canonical `refCount`.
   - Deletes only the canonical file's DynamoDB record.
   - **Preserves S3 object**.
3. **Deleting the last reference (`refCount <= 1`)**:
   - Deletes the underlying S3 object.
   - Deletes the DynamoDB record.

---

### 3. Shared-State Rate Limiting

#### The Architectural Problem: Horizontally Scaled Stateless Replicas
In Phase 6, three API instances (`api-1`, `api-2`, `api-3`) run behind an nginx load balancer. If rate limiting is implemented in-memory on each instance:
- A client can spray requests round-robin across all 3 replicas and achieve $3 \times$ the intended limit.
- Container restarts or scaling events reset rate limit windows unpredictably.

#### The Shared-State Solution: Redis
- **Why Redis over DynamoDB**:
  - **Latency**: Redis executes in-memory operations in sub-millisecond time ($< 1\text{ms}$), compared to 10–20ms for DynamoDB remote RPCs.
  - **Cost**: Rate limiting checks occur on every incoming HTTP request. Using DynamoDB would consume costly Write Capacity Units (WCUs) for transient counter state.
  - **Atomic Primitives & TTL**: Redis provides atomic `INCR` + `EXPIRE` pipeline operations with native TTL eviction, preventing storage leaks without requiring background cleanup.
- **Fail-Open Strategy**: If Redis experiences a transient outage, the rate limiter logs an error and allows requests through (fails open) rather than blocking all business traffic.

#### Rate Limiting Request Flow & Headers

```
Client                     nginx                 API (api-1/2/3)              Redis
  |                          |                          |                       |
  |--POST /uploads---------->|                          |                       |
  |                          |--round-robin------------>|                       |
  |                          |                          |--INCR rl:<key>:<win>->|
  |                          |                          |--EXPIRE (ttl)-------->|
  |                          |                          |<--current count-------|
  |                          |                          |                       |
  |                          |     ┌────────────────────┴──────────────────┐    |
  |                          |     │ Allowed? (count <= maxRequests)       │    |
  |                          |     ├───────────────────┬───────────────────┤    |
  |                          |     │ YES               │ NO                │    |
  |                          |     ├───────────────────┼───────────────────┤    |
  |                          |     │ • Process request │ • Return 429      │    |
  |                          |     │ • Set headers:    │ • Set headers:    │    |
  |                          |     │   X-RateLimit-*   │   Retry-After,    │    |
  |                          |     │                   │   X-RateLimit-*   │    |
  |                          |     └───────────────────┴───────────────────┘    |
  |<--HTTP 200/201 or 429----|<-------------------------|
```

Standard headers returned:
- `X-RateLimit-Limit`: Maximum requests permitted per window.
- `X-RateLimit-Remaining`: Remaining requests allowed in the current window.
- `X-RateLimit-Reset`: Unix epoch timestamp (seconds) when the current window resets.
- `Retry-After`: (On HTTP 429) Number of seconds the client must wait before retrying.

---

### Production Equivalent Mapping (Phase 7)

| Local (Phase 7 Docker Compose) | AWS Production Architecture |
|---|---|
| nginx container | AWS Application Load Balancer (ALB) |
| `api-1`, `api-2`, `api-3` | AWS ECS Fargate tasks across multiple Availability Zones |
| `worker-1`, `worker-2` | AWS ECS worker tasks or AWS Lambda SQS event source mapping |
| `redis:7-alpine` | Amazon ElastiCache for Redis (Cluster Mode / Multi-AZ) or AWS MemoryDB |
| DynamoDB Local | AWS DynamoDB (On-Demand billing, `ContentHashIndex` GSI) |
| LocalStack S3 | AWS S3 (Standard Storage with Lifecycle Rules) |
| LocalStack SQS | AWS SQS (Standard Queue with DLQ redrive policy) |

