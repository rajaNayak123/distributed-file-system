# Architecture (through Phase 2)

## Component responsibilities

| Component | Responsibility | Never does |
|---|---|---|
| API (Express) | AuthN/AuthZ, validation, orchestrates S3/DynamoDB calls, issues presigned URLs | Store file bytes, trust client-supplied keys/ownership |
| S3 (LocalStack/MinIO locally) | Owns file bytes | Know about users/ownership (that's enforced one layer up) |
| DynamoDB (DynamoDB Local locally) | Owns file/user metadata and upload state | Store file bytes |
| Client | Talks directly to S3 via presigned URLs for upload/download | Talk to the API for bytes |

## Upload sequence (Phase 2)

```
Client                         API                              S3               DynamoDB
  |                              |                                |                   |
  |--POST /uploads (meta)------->|                                |                   |
  |                              |--putItem status=INITIATED---------------------------->|
  |                              |--getPresignedPutUrl----------->|                   |
  |                              |<--presigned PUT URL------------|                   |
  |                              |--updateItem status=UPLOADING-------------------------->|
  |<--{uploadId,fileId,url}------|                                |                   |
  |                                                                |                   |
  |--PUT <bytes> directly to presignedUrl------------------------>|                   |
  |<--200 OK (from S3, not the API)--------------------------------|                   |
  |                                                                |                   |
  |--POST /uploads/:id/complete->|                                |                   |
  |                              |--updateItem status=COMPLETING------------------------>|
  |                              |--HeadObject------------------->|                   |
  |                              |<--exists / not found------------|                   |
  |                              |--updateItem status=COMPLETED or FAILED---------------->|
  |<--{status: COMPLETED|FAILED}-|                                |                   |
```

Key property: the API is on the request path for *metadata and authorization
decisions only*. The heaviest part of the operation - moving the actual bytes -
happens entirely between the client and S3, over a connection the API
authorized but is not a party to.

## Download sequence (Phase 2)

```
Client                         API                              S3
  |--GET /files/:id/download--->|
  |                              |--requireOwnedFile (DynamoDB, scoped by authenticated userId)
  |                              |--getPresignedGetUrl----------->|
  |                              |<--presigned GET URL------------|
  |<--{downloadUrl,expiresAt}----|
  |
  |--GET <bytes> directly from downloadUrl------------------------>|
  |<--200 OK + bytes (from S3, not the API)--------------------------|
```

## Why no server/instance owns any request's state

Every piece of information needed to serve a request - who the caller is (JWT,
verified per-request), what files they own (DynamoDB, queried per-request), and
where file bytes live (S3, addressed by a server-derived key stored in
DynamoDB) - is either recomputed from the request itself or fetched fresh from
a shared external store. No in-process cache, session, or local file backs any
of this. That's what makes "any API instance can serve any request"
(Phase 4's headline property) already true as of Phase 2, even though Phase 4
is where it's actually demonstrated with multiple replicas behind a load
balancer.

## Upload state machine

```
INITIATED --> UPLOADING --> COMPLETING --> COMPLETED
     \             \              \
      \-> FAILED     \-> FAILED     \-> FAILED
```

See `docs/decisions.md` for why this shape was chosen over a boolean flag, and
`apps/api/src/utils/uploadStateMachine.js` for the enforced transition table.

## Local dev topology (Phase 1/2)

```
docker-compose
 ├── localstack        (S3 + SQS emulation; SQS unused until Phase 6)
 ├── dynamodb-local     (DynamoDB Local)
 ├── dynamodb-init      (one-shot: creates Files/Users tables + EmailIndex GSI, then exits)
 └── api                (Express, port 3000)
```

Multi-instance/load-balanced topology, health-based routing, and the ASCII
diagrams for that are added in Phase 4. Multipart upload's sequence diagram is
added in Phase 3.
