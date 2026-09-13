# API Reference (through Phase 7)

Base URL (local dev): `http://localhost:3000`

All request and response bodies are JSON unless otherwise noted. Protected routes require:
```http
Authorization: Bearer <accessToken>
```

---

## Headers & Cross-Cutting Behaviors

### Rate Limiting (Phase 7)
All upload endpoints are rate limited via shared Redis state across all API replicas. Responses include:
- `X-RateLimit-Limit`: Maximum requests permitted per window (default: `30`).
- `X-RateLimit-Remaining`: Remaining requests allowed in the current window.
- `X-RateLimit-Reset`: Unix epoch timestamp (seconds) when the quota resets.

When the rate limit is exceeded, the API returns `429 Too Many Requests` with:
- `Retry-After`: Number of seconds the client must wait before retrying.
- Response body:
```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded, please try again later.",
  "retryAfter": 15
}
```

### Idempotency Keys (Phase 5)
Mutation endpoints (`POST /uploads` and `POST /uploads/:id/complete`) accept an optional header:
```http
Idempotency-Key: <unique-client-key>
```
- **In-flight concurrent requests**: Return `409 CONFLICT` (retry after backoff).
- **Completed requests**: Replay the original cached `200`/`201` response.
- **Mismatched payloads**: Return `422 UNPROCESSABLE ENTITY` if the key is reused with a different payload hash.

---

## Auth

### `POST /auth/register`
Creates a new user profile and returns access + refresh JWT tokens.

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
Errors: `400` (validation failure or email already registered).

### `POST /auth/login`
Authenticates user credentials.

Request:
```json
{ "email": "alice@example.com", "password": "secretpassword" }
```
Response `200`: Same shape as register.  
Errors: `401` (invalid email or password — generic error to prevent user enumeration).

### `POST /auth/refresh`
Rotates access and refresh tokens.

Request:
```json
{ "refreshToken": "..." }
```
Response `200`: Same shape as register.  
Errors: `401` (invalid/expired refresh token or user revoked).

---

## Uploads (Single-Part Presigned)

All upload routes require `Authorization: Bearer <accessToken>`.

### `POST /uploads`
Initiates a single-part upload session: creates a metadata record in status `UPLOADING` and returns a short-lived presigned S3 PUT URL. The client transmits file bytes directly to S3; the API never buffers file bytes.

Headers:
- `Idempotency-Key` *(optional)*

Request:
```json
{
  "fileName": "report.pdf",
  "contentType": "application/pdf",
  "size": 204800
}
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
Errors: `400` (validation failure, invalid content type, or file size > 5 GB), `401`, `429`.

### `POST /uploads/:id/complete`
Finalizes a single-part upload. The API calls S3 `HeadObject` to verify bytes were actually received before transitioning status to `COMPLETED`. On success, publishes a `FILE_UPLOADED` event to SQS for asynchronous checksumming, metadata validation, and deduplication.

Headers:
- `Idempotency-Key` *(optional)*

Response `200` (verified success):
```json
{
  "fileId": "uuid",
  "userId": "uuid",
  "fileName": "report.pdf",
  "size": 204800,
  "contentType": "application/pdf",
  "status": "COMPLETED",
  "etag": "\"etag-hex\"",
  "checksum": null,
  "createdAt": "2026-08-10T12:00:00.000Z",
  "updatedAt": "2026-08-10T12:02:00.000Z"
}
```
Response `422` (S3 object missing — transitioned to `FAILED`, not silently marked completed):
```json
{
  "fileId": "uuid",
  "status": "FAILED",
  "failureReason": "S3 object not found at completion time"
}
```
Errors: `400`, `401`, `404` (file not found or not owned by user), `429`.

---

## Multipart Uploads (Large Files)

For files larger than 100 MB (up to 5 GB).

### `POST /uploads/:id/multipart/initiate`
Initiates an S3 multipart upload session for an existing upload record.

Response `200`:
```json
{
  "fileId": "uuid",
  "s3UploadId": "s3-multipart-upload-id",
  "partSize": 52428800,
  "estimatedParts": 5
}
```

### `POST /uploads/:id/multipart/parts`
Generates presigned S3 PUT URLs for specified part numbers.

Request:
```json
{
  "partNumbers": [1, 2, 3]
}
```
Response `200`:
```json
{
  "parts": [
    { "partNumber": 1, "presignedUrl": "https://..." },
    { "partNumber": 2, "presignedUrl": "https://..." },
    { "partNumber": 3, "presignedUrl": "https://..." }
  ],
  "expiresAt": "2026-08-10T12:15:00.000Z"
}
```

### `POST /uploads/:id/multipart/complete`
Assembles all uploaded parts in S3. Verifies completion via `HeadObject` and transitions status to `COMPLETED`.

Request:
```json
{
  "parts": [
    { "partNumber": 1, "eTag": "\"etag-1\"" },
    { "partNumber": 2, "eTag": "\"etag-2\"" }
  ]
}
```
Response `200`: Same shape as `/uploads/:id/complete`.  
Response `422`: Returned if assembly fails or final object is missing.

### `POST /uploads/:id/multipart/abort`
Aborts an in-progress multipart upload in S3 and marks the record `FAILED`.

Response `200`:
```json
{
  "fileId": "uuid",
  "status": "FAILED",
  "aborted": true
}
```

---

## Files & Deduplication

All routes require `Authorization: Bearer <accessToken>`.

### `GET /files`
Lists files owned by the authenticated user.

Query Parameters:
- `includeIncomplete=true|false` (default: `false` — returns only `COMPLETED` files unless explicitly requested).

Response `200`:
```json
{
  "files": [
    {
      "fileId": "uuid-1",
      "fileName": "report.pdf",
      "size": 204800,
      "contentType": "application/pdf",
      "status": "COMPLETED",
      "checksum": "sha256-hex-digest",
      "contentHash": "sha256-hex-digest",
      "isDedup": false,
      "refCount": 2,
      "createdAt": "...",
      "updatedAt": "..."
    },
    {
      "fileId": "uuid-2",
      "fileName": "copy.pdf",
      "size": 204800,
      "contentType": "application/pdf",
      "status": "COMPLETED",
      "checksum": "sha256-hex-digest",
      "contentHash": "sha256-hex-digest",
      "isDedup": true,
      "canonicalFileId": "uuid-1",
      "canonicalUserId": "user-uuid",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

### `GET /files/:id`
Retrieves metadata for a single owned file.

Query Parameters:
- `includeIncomplete=true|false` (default: `false`).

Response `200`:
```json
{
  "file": {
    "fileId": "uuid",
    "fileName": "report.pdf",
    "status": "COMPLETED",
    "checksum": "sha256-hex-digest",
    "isDedup": false,
    "refCount": 1
  }
}
```
Errors: `404` (not found, not owned by user, or filtered out by `includeIncomplete=false`).

### `GET /files/:id/download`
Issues a short-lived presigned S3 GET URL directly to the object bytes. For deduplicated files, this points to the shared canonical S3 object.

Response `200`:
```json
{
  "downloadUrl": "https://...",
  "expiresAt": "2026-08-10T12:05:00.000Z"
}
```
Errors: `401`, `404`, `409 CONFLICT` (file exists but status is not `COMPLETED`).

### `DELETE /files/:id`
Deduplication-aware idempotent file deletion:
- **If deleting an alias (`isDedup: true`)**: Decrements canonical `refCount`, deletes the DynamoDB record, and **preserves the shared S3 object**.
- **If deleting a canonical file with other active references (`refCount > 1`)**: Decrements `refCount`, deletes the DynamoDB record, and **preserves the S3 object**.
- **If deleting the last active reference (`refCount <= 1`)**: Deletes the underlying S3 object, then deletes the DynamoDB record.

Response `200`:
```json
{
  "deleted": true,
  "alreadyDeleted": false,
  "s3Deleted": true
}
```
Calling `DELETE` again returns `{ "deleted": true, "alreadyDeleted": true }` with `200 OK` (idempotent, does not reveal cross-user existence).

### `POST /files/:id/retry`
Recovers an upload in `FAILED` status. Transitions the record back to `UPLOADING` and re-issues a presigned PUT URL for the same S3 key and DynamoDB item, avoiding ghost record accumulation.

Response `200`:
```json
{
  "fileId": "uuid",
  "presignedUrl": "https://...",
  "expiresAt": "2026-08-10T12:15:00.000Z",
  "status": "UPLOADING"
}
```
Errors: `400` (file is not in `FAILED` status), `401`, `404`.

---

## Health & Readiness

### `GET /health`
Liveness probe. Returns `200 OK` as long as the Express process is running.
```json
{
  "status": "ok",
  "instance": "api-1"
}
```

### `GET /ready`
Readiness probe used by the load balancer (nginx / AWS ALB). Performs live connectivity checks to DynamoDB and S3.
- Response `200`: All upstream dependencies are healthy.
- Response `503`: One or more dependencies are unreachable.
```json
{
  "status": "ready",
  "instance": "api-1",
  "checks": {
    "dynamo": "ok",
    "s3": "ok"
  }
}
```

---

## Error Envelope Format

All application errors share a standardized JSON envelope:
```json
{
  "error": {
    "message": "File report.pdf exceeds maximum allowed size",
    "category": "VALIDATION_ERROR",
    "details": {}
  }
}
```

Standard `category` values:
| Category | HTTP Status | Description |
|---|---|---|
| `VALIDATION_ERROR` | `400` | Malformed request body, illegal parameter, or size exceeded |
| `AUTHENTICATION_ERROR` | `401` | Missing, invalid, or expired JWT |
| `AUTHORIZATION_ERROR` | `403` | User does not have permission |
| `NOT_FOUND` | `404` | Resource does not exist under authenticated user scope |
| `CONFLICT` | `409` | State machine collision or concurrent in-flight idempotency lock |
| `INVALID_STATE_TRANSITION` | `400` | Attempted invalid jump in upload state machine |
| `OBJECT_NOT_FOUND` | `422` | S3 object missing at completion time |
| `UPSTREAM_SERVICE_ERROR` | `502` / `503` | S3, DynamoDB, or SQS unreachable |
| `INTERNAL_ERROR` | `500` | Unexpected unhandled server exception |
