# API Reference (through Phase 2)

Base URL (local dev): `http://localhost:3000`

All request/response bodies are JSON unless noted. Protected routes require
`Authorization: Bearer <accessToken>`.

---

## Auth

### `POST /auth/register`
Request:
```json
{ "email": "alice@example.com", "password": "at-least-8-chars" }
```
Response `201`:
```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "user": { "userId": "uuid", "email": "alice@example.com" }
}
```
Errors: `400` (invalid email/password, or email already registered).

### `POST /auth/login`
Request:
```json
{ "email": "alice@example.com", "password": "..." }
```
Response `200`: same shape as register.
Errors: `401` (invalid email or password - deliberately the same error for both
cases so login doesn't reveal which emails are registered).

### `POST /auth/refresh`
Request:
```json
{ "refreshToken": "..." }
```
Response `200`: same shape as register (rotates both tokens).
Errors: `401` (invalid/expired refresh token, or user no longer exists).

---

## Uploads (Phase 2 - presigned)

All routes below require `Authorization: Bearer <accessToken>`.

### `POST /uploads`
Initiates an upload: creates a metadata record (`INITIATED` -> `UPLOADING`) and
returns a short-lived presigned S3 PUT URL. The client PUTs the file bytes
directly to `presignedUrl` - the API never sees them.

Request:
```json
{ "fileName": "report.pdf", "contentType": "application/pdf", "size": 204800 }
```
Response `201`:
```json
{
  "uploadId": "uuid",
  "fileId": "uuid",
  "presignedUrl": "https://...",
  "expiresAt": "2026-08-10T12:15:00.000Z"
}
```
Errors: `400` (invalid fileName/contentType/size, or size exceeds the
configured maximum), `401`.

Client-side contract: `PUT` the raw file bytes to `presignedUrl` with a
`Content-Type` header matching what was sent to `/uploads`, before `expiresAt`.

### `POST /uploads/:id/complete`
Call after the client's PUT to `presignedUrl` succeeds. The server verifies the
object actually exists in S3 (`HeadObject`) before marking the upload
`COMPLETED` - it does not trust the client's claim of success.

Response `200` (verified success):
```json
{
  "fileId": "uuid",
  "userId": "uuid",
  "fileName": "report.pdf",
  "size": 204800,
  "contentType": "application/pdf",
  "status": "COMPLETED",
  "etag": "\"...\"",
  "checksum": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```
Response `422` (S3 object missing - transitioned to `FAILED`, not silently
accepted):
```json
{
  "fileId": "uuid",
  "status": "FAILED",
  "failureReason": "S3 object not found at completion time",
  "...": "..."
}
```
Calling `complete` again on an already-`COMPLETED` upload returns the current
record unchanged (idempotent). Calling it on an upload not in `UPLOADING`
(and not already `COMPLETED`) returns `400`.
Errors: `400`, `401`, `404` (fileId not owned by/not found for this user).

---

## Files

All routes below require `Authorization: Bearer <accessToken>`.

### `GET /files`
Query params: `includeIncomplete=true|false` (default `false` - only
`COMPLETED` files are returned unless explicitly opted in).

Response `200`:
```json
{ "files": [ { "fileId": "uuid", "fileName": "report.pdf", "status": "COMPLETED", "...": "..." } ] }
```

### `GET /files/:id`
Same `includeIncomplete` query param and default behavior as the list
endpoint, applied to a single file.

Response `200`: `{ "file": { ... } }`
Errors: `404` (not found, not owned by the caller, or excluded by the
completeness filter).

### `GET /files/:id/download`
Returns a short-lived presigned S3 GET URL - never the file bytes themselves.
Ownership is re-verified server-side against the authenticated `userId`; the
`s3Key` used is the one stored on the record, never anything client-supplied.
Only files with `status = COMPLETED` are downloadable.

Response `200`:
```json
{ "downloadUrl": "https://...", "expiresAt": "2026-08-10T12:05:00.000Z" }
```
Errors: `401`, `404` (not found/not owned), `409 CONFLICT` (file exists and is
owned by the caller, but isn't `COMPLETED` yet - e.g. still `UPLOADING` or
already `FAILED`).

### `DELETE /files/:id`
Idempotent. Deletes the S3 object, then the DynamoDB item (see
`docs/decisions.md` for the ordering rationale and partial-failure handling).

Response `200`:
```json
{ "deleted": true, "alreadyDeleted": false }
```
Calling it again (or on a file that isn't the caller's / doesn't exist)
returns `{ "deleted": true, "alreadyDeleted": true }` with `200` - this is
deliberate: it does not leak whether a file existed under someone else's
account.

---

## Health

### `GET /health`
Liveness only in Phase 1/2 - always `200` while the process is up.
`GET /ready` (dependency-aware readiness) is added in Phase 4.

---

## Error shape

All errors share one shape:
```json
{ "error": { "message": "human-readable message", "category": "MACHINE_READABLE_CATEGORY", "details": {} } }
```
`category` values used so far: `VALIDATION_ERROR`, `AUTHENTICATION_ERROR`,
`AUTHORIZATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `INVALID_STATE_TRANSITION`,
`UPSTREAM_SERVICE_ERROR`, `INTERNAL_ERROR`.
