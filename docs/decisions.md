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


