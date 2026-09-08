# Architecture (through Phase 6)

## Component responsibilities

| Component | Responsibility | Never does |
|---|---|---|
| API (Express) | AuthN/AuthZ, validation, orchestrates S3/DynamoDB calls, issues presigned URLs | Store file bytes, trust client-supplied keys/ownership |
| S3 (LocalStack locally / AWS S3 in prod) | Owns file bytes | Know about users/ownership (that's enforced one layer up) |
| DynamoDB (DynamoDB Local locally / AWS DynamoDB in prod) | Owns file/user metadata and upload state | Store file bytes |
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
