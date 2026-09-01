# Failure Scenarios

This is a stub through Phase 2 - it gets filled in with *observed* (not just
theoretical) behavior in Phase 8, once real load/failure testing has run
against the live multi-instance system. What's below reflects behavior that
already exists and is covered by tests as of Phase 2.

| Scenario | Expected behavior | Status |
|---|---|---|
| Client claims a PUT succeeded but the S3 object doesn't exist | `POST /uploads/:id/complete` calls `HeadObject`, finds nothing, transitions the record to `FAILED` with `failureReason: "S3 object not found at completion time"`. Never silently marked `COMPLETED`. | Implemented + tested (`uploads.presigned.test.js`) |
| `complete` called twice on an already-`COMPLETED` upload | Returns the existing record unchanged; not an error, not a duplicate transition. | Implemented |
| `complete` called on a file not in `UPLOADING` (and not `COMPLETED`) | `400 VALIDATION_ERROR`. | Implemented |
| Illegal state transition attempted anywhere in code (e.g. `INITIATED -> COMPLETED`) | `uploadStateMachine.assertValidTransition` throws `InvalidStateTransitionError` before any DynamoDB write is attempted. | Implemented + unit tested |
| `DELETE /files/:id` called on an already-deleted or nonexistent file | Returns `200 { deleted: true, alreadyDeleted: true }`, not `404`/`409`. | Implemented + tested |
| S3 delete succeeds, DynamoDB delete then fails | Logged distinctly as `DYNAMODB_DELETE_FAILED_AFTER_S3_DELETE`; error propagates to the caller as a `502`. Leaves an orphaned metadata row - this is the seed of the Phase 7 reconciliation problem (documented in `docs/decisions.md`, not yet auto-repaired). | Logged, not yet auto-reconciled (Phase 7) |
| A user requests another user's `fileId` via `GET /files/:id`, `/download`, or `DELETE` | `404` in all three cases (never `403`, to avoid confirming existence under someone else's account). Ownership is re-derived from the DynamoDB partition key `USER#<authenticatedUserId>`, never trusted from the request. | Implemented + tested (`files.ownership.test.js`, `filesRepository.test.js`) |
| A download is requested for a file that isn't `COMPLETED` yet (still `INITIATED`/`UPLOADING`/`COMPLETING`) or is `FAILED` | `409 CONFLICT` - no presigned URL is generated for an object that hasn't been S3-verified. | Implemented + tested (`uploads.presigned.test.js`) |
| Missing/invalid JWT on a protected route | `401 AUTHENTICATION_ERROR`. | Implemented + tested |
| S3/DynamoDB transient errors (timeouts, throttling) | Currently surfaces as `502 UPSTREAM_SERVICE_ERROR` with no retry. Explicit timeouts + retry/backoff/jitter are added in Phase 5. | Not yet implemented (Phase 5) |
| API instance crashes mid-upload-session | Not yet demonstrable - requires the multi-instance/load-balanced setup from Phase 4. Nothing in the Phase 2 design *should* make this worse than any other request, since no upload state lives in-process, but this needs an actual kill-and-observe test once Phase 4 exists. | Deferred to Phase 4/8 |

See `docs/decisions.md` for the reasoning behind each of these choices.
