# Architecture Decisions

Short "why" entries, added as the project progresses. Newest entries at the bottom
of each phase's section.

## Phase 1

- **S3 for file bytes, DynamoDB for metadata, never local disk.** API instances
  must be interchangeable and stateless from day one (this is the whole point of
  the project - see README problem statement). Writing bytes to local disk would
  make an instance "sticky" (only it could serve that file later) and would be
  lost on container restart/redeploy. S3 is durable, shared, and infinitely
  scalable for the object-storage half of the problem; DynamoDB gives us fast,
  predictable-latency key-value/query access for the metadata half.

- **DynamoDB key schema: `PK = USER#<userId>`, `SK = FILE#<fileId>`.** Chosen to
  directly support the two Phase 1 access patterns without any GSI: "list all of
  a user's files" (Query on PK) and "get one file, scoped to its owner" (GetItem
  on PK+SK). Because ownership is baked into the partition key itself, a lookup
  under the wrong user's PK simply returns nothing - there's no way to
  "accidentally" fetch someone else's item even with a correct fileId, which is
  the first line of defense behind the "always re-derive ownership server-side"
  rule.

- **JWT access + refresh tokens, bcrypt-hashed passwords.** Stateless auth (no
  server-side session store) is required for the API to remain horizontally
  scalable without shared session state - this is set up correctly from Phase 1
  so Phase 4's multi-instance work doesn't need an auth rewrite. Short-lived
  access tokens (15m) limit the blast radius of a leaked token; refresh tokens
  (7d) avoid forcing re-login constantly. bcrypt (cost 12) is a well-understood,
  slow-by-design hash appropriate for password storage.

## Phase 2

- **Presigned URLs instead of routing bytes through the API.** This is the
  single most important architectural correction in the whole project. Phase 1's
  `POST /files` intentionally proved the shape of the system but violates the
  core principle (API servers must never hold file bytes) the moment a real
  file is uploaded - `multipart/form-data` streams the whole file through the
  Node process's memory/disk buffers. A presigned PUT URL lets the client talk
  directly to S3; the API's job shrinks to "decide whether this user is allowed
  to write to this specific key, for a short time" - which is exactly the kind
  of decision a stateless, horizontally-scaled API tier is good at.

- **Explicit `INITIATED -> UPLOADING -> COMPLETING -> COMPLETED` state machine
  instead of a boolean `uploaded` flag.** A raw boolean can't represent "we
  handed out a URL but don't yet know if the client used it," "we're in the
  middle of verifying," or "verification failed." Each state maps to a real,
  observable moment in the upload lifecycle, and each has a well-defined next
  state (including `FAILED` from anywhere non-terminal). This is what makes the
  completion endpoint's behavior legible: you can look at `status` and know
  exactly what has and hasn't been confirmed. Phase 3 (multipart) reuses this
  exact machine; Phase 7 (reconciliation) queries specifically for items stuck
  mid-machine past a threshold.

- **`POST /uploads/:id/complete` always calls S3 `HeadObject` before marking
  `COMPLETED`.** We do not trust a client's claim that its PUT succeeded - a
  client could lie, crash before confirming, or have its PUT silently fail on a
  flaky network without us knowing. `HeadObject` is the cheapest possible S3
  call that proves the object exists (no bytes downloaded). If it's missing, we
  transition to `FAILED` with a stated reason rather than either (a) trusting
  the client into a false `COMPLETED`, or (b) leaving the record stuck in
  `COMPLETING` forever.

- **S3 object key is always server-derived: `users/<userId>/files/<fileId>`,
  never client-supplied.** A client could otherwise request a presigned URL for
  an arbitrary key (e.g. someone else's existing object path) and, depending on
  bucket policy, potentially overwrite or read data it shouldn't touch. Deriving
  the key purely from the authenticated `userId` (from the verified JWT) and a
  server-generated `fileId` (UUID) removes any input the client controls from
  the authorization-relevant part of the request.

- **`GET /files` and `GET /files/:id` default to `status = COMPLETED` only,**
  with an explicit `?includeIncomplete=true` opt-in. Most callers (e.g. a
  frontend file browser) want "files I can actually download," not
  half-finished upload sessions. Making completeness the default avoids every
  caller needing to filter client-side, while the query param keeps
  in-progress/failed uploads inspectable for debugging or a "my uploads"
  in-progress view.

- **Delete order: S3 object first, then the DynamoDB item; and delete is
  idempotent.** If the S3 delete succeeds but the subsequent DynamoDB delete
  fails, we're left with an orphaned metadata row pointing at a now-nonexistent
  object - annoying, but cheap and easy to detect and repair (this is exactly
  Phase 7 reconciliation Case A: "DynamoDB says exists, S3 object missing"). The
  reverse ordering (DynamoDB first) would instead leave a real S3 object with no
  metadata pointing at it - a silent, ongoing storage cost that's much harder to
  discover. We explicitly log which half failed with a distinct error category
  (`S3_DELETE_FAILED` vs `DYNAMODB_DELETE_FAILED_AFTER_S3_DELETE`) so it's
  diagnosable now and reconcilable in Phase 7, rather than hidden. Delete on an
  already-deleted or nonexistent file returns `{ deleted: true, alreadyDeleted:
  true }` with a 200, not a 404 - repeated DELETE calls (e.g. from a retrying
  client) must be safe.

- **Integration tests run against in-memory fakes for `FilesRepository`,
  `UsersRepository`, and `StorageService`, selected via a dedicated Jest
  `integration` project + `moduleNameMapper`, rather than a real LocalStack/
  DynamoDB Local instance.** The dev sandbox this project was drafted in cannot
  run Docker containers, so these fakes let the full request/response/business-
  logic path (routing, auth, validation, the state machine, ownership checks)
  be exercised and asserted deterministically without any external service.
  They intentionally implement the exact same method signatures as the real
  `FilesRepository`/`UsersRepository`/`StorageService` classes so swapping them
  back out is a one-line change. The unit tests for the storage/metadata
  *wrapper* modules use `aws-sdk-client-mock` against the real AWS SDK v3
  client classes instead, which does exercise real SDK request/response
  shapes. Phase 8's CI pipeline is specified to run the same integration
  suite against real LocalStack + DynamoDB Local service containers - that
  path is written into the GitHub Actions workflow description but has not
  been executed in this environment.

## Post-Phase-2 audit fixes

A follow-up review caught three real gaps in the initial Phase 2 pass, closed
as follows:

- **Downloads were not gated on upload status.** `GET /files/:id/download`
  originally generated a presigned GET URL for any owned file regardless of
  `status` - meaning a file still `INITIATED`/`UPLOADING`/`COMPLETING`, or one
  that had already been marked `FAILED`, would still hand back a download URL
  pointing at an S3 object that might not exist (or wasn't yet confirmed to).
  Fixed: `getDownloadUrl` now requires `status === 'COMPLETED'` and returns
  `409 CONFLICT` otherwise, with the current status in the message. Covered by
  two new integration tests (in-progress upload, and a `FAILED` upload).

- **The real `FilesRepository`/`UsersRepository` classes had zero direct test
  coverage.** The integration suite only ever exercised the in-memory fakes
  standing in for them; the actual DynamoDB key-schema logic (conditional
  transitions via `ConditionExpression`, the `USER#<userId>` partition scoping
  that ownership enforcement depends on, `ConditionalCheckFailedException`
  translation to `ConflictError`/`NotFoundError`) was never run against even a
  mocked DynamoDB client. Fixed: added
  `tests/unit/filesRepository.test.js` and `tests/unit/usersRepository.test.js`,
  both exercising the real classes via `aws-sdk-client-mock` against
  `DynamoDBDocumentClient`, including an explicit test asserting that a lookup
  under an attacker's `userId` is scoped to `PK = USER#attacker` and therefore
  can never resolve to a victim's item even with the correct `fileId`.

- **Presigned URL generation itself was untested against the real AWS SDK v3
  signer.** `getPresignedPutUrl`/`getPresignedGetUrl` - arguably the single
  most important pair of methods in the whole Phase 2 deliverable - were only
  ever invoked through the fake storage service in integration tests. Fixed:
  added a `describe` block in `tests/unit/storage.service.test.js` that
  constructs a real `S3Client` (dummy static credentials, no network call is
  made - `getSignedUrl` signs locally) and asserts the resulting URLs are
  correctly scoped to the bucket/key and expiry. Writing this test also caught
  an incorrect assumption in an early draft (that the key would appear
  percent-encoded, path-style) - the real SDK produces a virtual-hosted-style
  URL with the key as a literal path segment, which the test now asserts
  correctly.

- Also added a static regression guard (`tests/unit/noDiskWrites.test.js`)
  that fails the build if `multer` or any `fs.write*`/`fs.createWriteStream`
  call is ever introduced into `src/` - turning the Phase 1 DoD item "no file
  bytes written to local disk" into an enforced test rather than a README
  claim.

## Post-audit restructure: layered folders + ES Modules

At the person's explicit request, the codebase was restructured a second
time, after the audit above:

- **Folder structure changed from domain-based to layer-based.** The original
  blueprint's repo structure (and the initial Phase 1/2 implementation) used
  domain folders - `auth/`, `users/`, `files/`, `uploads/`, `storage/`,
  `metadata/` - each bundling its own controller, service, and routes file
  together. This is a legitimate, common structure (it keeps everything about
  one feature in one place), but the person asked for a layered structure
  instead: `controllers/`, `routes/`, `services/`, `repositories/`,
  `middlewares/`, `utils/`, each containing all modules for that concern
  across the whole app. This is also a legitimate, common structure (it makes
  "all the HTTP-handling code" or "all the DynamoDB access" easy to scan in
  one place, at the cost of needing to jump between folders to trace one
  feature end-to-end). Neither is more "correct" than the other - this is a
  deliberate deviation from the structure the original blueprint prompt
  specified, made because the person asked for it directly. `storage.service.js`
  and `metadata.service.js` (the thin AWS SDK wrappers) live under
  `services/` alongside the business-logic services (`auth.service.js`,
  `uploads.service.js`, `files.service.js`); the AWS SDK client instances
  themselves (`S3Client`, `DynamoDBDocumentClient`) got their own `clients/`
  folder so `services/` isn't a mix of "raw client singleton" and "class that
  uses a client". The `idempotency/` placeholder folder from Phase 1/2 was
  dropped - Phase 5 will add `idempotency.repository.js`,
  `idempotency.service.js`, etc. directly into the existing layer folders
  rather than needing a dedicated placeholder now that the structure isn't
  domain-based.

- **Converted from CommonJS to ES Modules.** `apps/api/package.json` (and
  `infra/docker/package.json`) now declare `"type": "module"`; every source
  file uses `import`/`export` instead of `require`/`module.exports`, and every
  relative import includes an explicit `.js` extension - Node's native ESM
  resolver requires this (CommonJS's `require` doesn't). This was verified to
  actually work, not just "look like" ESM: `node src/app.js` was loaded
  directly via dynamic `import()` and the real `node src/server.js` process
  was started and hit with real HTTP requests (`GET /health` -> `200`,
  `POST /auth/register` -> a correctly-formed `502 UPSTREAM_SERVICE_ERROR`
  when no DynamoDB is reachable) - see the README's testing section. Jest
  itself is built on CommonJS `require()` internals and doesn't run ES Module
  source natively without either Node's experimental VM-modules flag (still
  flagged as experimental and awkward to combine reliably with
  `moduleNameMapper`-based test doubles) or a transpilation step. This project
  uses the more common, stable path: `babel-jest` + `@babel/preset-env`
  transpile the ES Module source and test files to CommonJS *only* at test-run
  time (`babel.config.cjs`) - the application itself never goes through
  Babel. `jest.config.cjs` and `babel.config.cjs` are named `.cjs` specifically
  because a `"type": "module"` package would otherwise cause Node to parse a
  plain `.js` config file as an ES Module, breaking the `module.exports`
  syntax those config files need. The `integration` Jest project's
  `moduleNameMapper` (which swaps real repositories/storage for in-memory
  fakes) continues to work unchanged under this setup, since Babel's
  commonjs transform still produces ordinary `require()` calls for Jest to
  intercept.



## Phase 5

- **Idempotency Keys (DynamoDB backed).** The `POST /uploads` and `POST /uploads/:id/complete` endpoints create/finalize state and are not inherently idempotent. We use an `IdempotencyKeys` table with atomic conditional puts to detect duplicates. In-progress duplicates return 409 (client should back off and poll), and completed duplicates replay the original 200 response. Key reuse with a different payload hash returns 422.
- **Explicit SDK Timeouts.** Network partitions (especially to S3) can cause the SDK to hang indefinitely, tying up Express workers. We've explicitly set `connectionTimeout` (3s) and `socketTimeout` (min 30s for S3 HeadObject/presigning) using the Smithy `NodeHttpHandler`. We also added a global Express request timeout (60s).
- **SDK built-in retry strategy.** Rather than hand-rolling a retry loop for DynamoDB/S3, we configure the SDK's `maxAttempts` (default 3) which uses the built-in `StandardRetryStrategy` (exponential backoff + jitter). The SDK handles transient errors automatically.
- **Validation errors bypass retries.** Deterministic 4xx errors and validation failures (e.g. file too large) are never retried because they are thrown directly as `AppError` subclasses before reaching the SDK layer.
- **FAILED → UPLOADING transition.** If an upload fails mid-flight, `POST /files/:id/retry` transitions it back to UPLOADING and re-issues a presigned URL using the *same* S3 key and DynamoDB record. This avoids leaving ghost records in the database.

## Phase 6

- **Explicit SQS publish from the API instead of S3 Event Notifications.** In
  production, configuring `s3:ObjectCreated:*` to push directly to SQS is the
  more elegant approach — it removes the API from the notification path entirely.
  For local dev, however, S3 Event Notifications in LocalStack require additional
  bucket-notification configuration that is fiddly to get right and makes
  integration tests non-deterministic (the event fires at an unknown time relative
  to the test assertion). Explicit publish from `uploads.service.js` after
  `status → COMPLETED` keeps the signal path synchronous and testable. The
  publish is fire-and-forget: if SQS is unavailable, the upload is still durably
  COMPLETED in DynamoDB; the worker picks it up on a retry or the Phase 7
  reconciliation job catches files with `checksum: null`. This is documented as a
  known trade-off, not a mistake.

- **Visibility timeout = 300 seconds (5 minutes).** SHA-256 computation on a
  5 GB file streamed through the Node `crypto` module takes at most 2–3 minutes
  on constrained hardware; 5 minutes gives 2× headroom. The S3 socket timeout on
  the worker client is set to at least 5 minutes to match. Using a value shorter
  than the expected maximum processing time would cause SQS to re-deliver
  messages that are still being processed, resulting in duplicate work — the
  idempotency guards in `checksum.processor.js` make duplicates safe but
  wasteful.

- **maxReceiveCount = 5 before DLQ.** Five attempts gives the worker three
  genuine retries beyond the first attempt, while keeping the retry window
  bounded. At 5 minutes per visibility cycle, a message can spend up to 25
  minutes in transit before landing in the DLQ — far more than enough to recover
  from transient S3/DynamoDB errors. A lower value (e.g. 3) risks pushing
  recoverable transient failures into the DLQ; a higher value (e.g. 10) delays
  operator awareness of genuinely broken messages.

- **Worker is a standalone `apps/worker/` application, not a sub-module of
  `apps/api/`.** Separating them means: (a) the API Docker image stays lean —
  no worker runtime, no `node-cron`, no streaming S3 I/O; (b) worker and API can
  scale independently (e.g. one worker replica per 10 API replicas); (c) a worker
  crash cannot affect the API's ability to serve upload/download requests.

- **Cleanup cron moved from the API to the worker.** `apps/api/src/cron/cleanup.js`
  started a `setInterval` in `server.js`, meaning three cron jobs were running
  simultaneously across `api-1`, `api-2`, and `api-3`. While the DynamoDB
  conditional expressions made concurrent cleanup safe, it was unnecessary load
  and violated the principle that the API should be a pure request/response
  process. Moving cleanup to the worker makes the API fully stateless: it starts
  no background work, holds no timers, and can be replaced at any time without
  disrupting in-progress cleanup cycles.

- **DLQ inspection via CLI script, not an HTTP endpoint.** Adding an admin HTTP
  endpoint to the worker would require an HTTP server, authentication, and
  deployment of a network-accessible port — significant complexity for an
  occasional operational need. A CLI script (`scripts/inspect-dlq.js`) run
  directly against LocalStack or real AWS (with appropriate credentials) is
  simpler, safer (no credentials in HTTP headers), and consistent with how AWS
  operators typically inspect SQS queues.

- **`updateChecksum` uses `attribute_exists(PK)` conditional write.** This makes
  checksum computation idempotent: if two worker replicas both receive the same
  message (e.g. after a visibility timeout race), the second write is identical
  (same SHA-256 of the same bytes) and the conditional expression succeeds. If
  the item was deleted between message publish and consume, the write fails with
  `ConditionalCheckFailedException` which is not retried (the processor returns
  `{skipped: true}`). Without this guard, a concurrent second write would succeed
  but would silently overwrite a valid checksum with an identical value — harmless,
  but wasteful of a DynamoDB write unit.

## Phase 7

- **S3 and DynamoDB are not one atomic transaction; bounded staleness via reconciliation loop.**
  S3 and DynamoDB are separate distributed services with independent APIs, consensus
  models, and failure domains. Distributed transactions (2PC) across them do not exist.
  Even with deliberate write ordering, failures at network boundaries inevitably produce
  consistency gaps:
  - *Case A (DynamoDB says exists, S3 missing)*: An upload record is left in `UPLOADING`,
    `COMPLETING`, or even falsely marked `COMPLETED` when the S3 object does not exist
    (e.g. client never uploaded bytes, PUT was aborted, or an S3 delete succeeded while
    the subsequent DynamoDB delete failed).
  - *Case B (S3 object exists, DynamoDB missing or failed)*: S3 retains an object with no
    active DynamoDB record (e.g. DynamoDB put failed after S3 PUT, or an abandoned upload
    part), causing ongoing storage cost leakage.
  The reconciliation loop (`runReconciliation`) in `apps/worker` is the anti-entropy
  mechanism that bounds staleness to the configured cron interval (default: 15 minutes).
  For Case A, suspicious records are checked with S3 `HeadObject`; missing objects are
  explicitly marked `FAILED` with `failureReason: "reconciliation: object missing"` rather
  than silently persisting as completed. For Case B, periodic `ListObjectsV2` sweeps past
  an orphan grace period (default: 60 minutes, guarding against in-flight uploads) purge
  orphaned objects from S3.

- **Deduplication: ContentHashIndex GSI and SHA-256 collision safety.**
  SHA-256 produces a 256-bit cryptographic digest ($2^{256} \approx 1.15 \times 10^{77}$
  possible values). By the birthday paradox, reaching even a 50% probability of a single
  hash collision requires hashing approximately $2^{128} \approx 3.4 \times 10^{38}$
  distinct files. For an enterprise storage system holding 1 billion ($10^9$) files, the
  collision probability is below $10^{-59}$ — dozens of orders of magnitude lower than the
  rate of uncorrectable hardware bit-flips or DRAM cosmic-ray corruption. Content hashing
  is therefore mathematically safe for deduplication without expensive byte-by-byte
  stream comparison.
  To look up existing content by hash efficiently, we add the `ContentHashIndex` Global
  Secondary Index (PK: `contentHash`) on the `Files` table. Without this GSI, detecting
  duplicates would require an $O(N)$ table scan on every completed upload.
  When an upload completes, the worker checks `ContentHashIndex`. If an identical file
  exists, the new file points its `s3Key` to the canonical object, sets `isDedup: true`,
  increments the canonical object's atomic `refCount`, and immediately deletes the redundant
  newly uploaded S3 object. On deletion, an alias file decrements the canonical `refCount`
  without deleting S3; the canonical file only deletes the S3 object when `refCount <= 1`
  (last reference).

- **Redis architectural justification for cross-instance rate limiting.**
  In our horizontally scaled API tier (3 replicas `api-1`, `api-2`, `api-3` behind nginx),
  in-memory rate limiters fail because clients can bypass limits by spraying requests
  across replicas, multiplying allowable traffic by $N$.
  DynamoDB is inappropriate for per-request rate limiting because it incurs write latency
  (10–20ms), high cost ($WCU$ consumption on every incoming request), and partition
  key hot-spotting.
  Redis is specifically chosen because it provides in-memory sub-millisecond atomic
  operations (`INCR` + `EXPIRE`), native key TTL expiration, and negligible CPU overhead.
  The rate limiter uses an atomic fixed window counter returning HTTP 429 Too Many Requests
  with standard `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
  `X-RateLimit-Reset` headers.

