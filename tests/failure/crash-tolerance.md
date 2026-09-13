# Crash Tolerance — Phase 4 Demo

## What this proves

Stopping one API replica mid-traffic does **not** cause failures for
in-flight or subsequent requests. The remaining two replicas continue
serving without interruption.

This is the Phase 4 "strong demo" required by the blueprint.

---

## Why it works

Every piece of state that a request needs is either:

| What | Where | Per-instance? |
|------|-------|---------------|
| Caller identity | JWT — verified cryptographically from the `Authorization` header | ❌ No |
| File/user metadata | DynamoDB — queried fresh on every request | ❌ No |
| File bytes | S3 — accessed via a key stored in DynamoDB | ❌ No |
| Upload state | DynamoDB state machine | ❌ No |
| In-memory cache | None | N/A |
| Local file writes | None | N/A |

There is nothing in a single server's memory or disk that a second server
would need to replay or resume a request. Any replica can serve any
request at any time.

---

## Prerequisites

```bash
# 1. Start the full stack
docker compose up --build -d

# 2. Verify it's healthy (all three replicas should show "ready")
curl http://localhost:3000/ready | jq .

# 3. Install jq (if not present)
brew install jq      # macOS
apt-get install jq   # Ubuntu/Debian
```

---

## Running the demo

```bash
bash tests/load/crash-tolerance.sh
```

### What happens

| Step | Action |
|------|--------|
| 1 | Register a fresh test user |
| 2 | Log in, get a JWT |
| 3 | Fire 40 `POST /uploads` requests sequentially |
| 4 | After request 15, `docker stop dfs-api-2` is called |
| 5 | Requests 16–40 continue being served by `api-1` and `api-3` |
| 6 | Script prints pass/fail per request and a final summary |
| 7 | `api-2` is restarted to restore full capacity |

---

## Expected output (truncated)

```
▶ Checking stack is up...
✓ Stack is up
✓ /ready is healthy
▶ Registering test user: crash-test-1725723600@example.com
✓ Registered
▶ Logging in...
✓ Got JWT
▶ Firing 40 upload-initiation requests...
▶ api-2 will be stopped after the first 15 requests.

  Request  1: ✓ 201 OK
  Request  2: ✓ 201 OK
  ...
  Request 15: ✓ 201 OK
▶ >>> Stopping dfs-api-2 mid-traffic (simulating crash)...
▶ >>> dfs-api-2 stopped. Remaining requests should still succeed.

  Request 16: ✓ 201 OK
  Request 17: ✓ 201 OK
  ...
  Request 40: ✓ 201 OK

────────────────────────────────────────
▶ Results:
  Total:    40
✓ Success:  40
✓ Failures: 0
────────────────────────────────────────

✓ PASS — All 40 requests succeeded despite killing api-2 mid-traffic.
         The load balancer automatically routed around the failed instance.
▶ Restarting dfs-api-2 to restore full capacity...
✓ dfs-api-2 restarted
```

---

## Checking which replica answered (round-robin verification)

Before stopping api-2, send a few requests and check the
`X-Upstream-Server` header:

```bash
for i in 1 2 3 4 5 6; do
  curl -si http://localhost:3000/health | grep -i x-upstream-server
done
```

Expected output rotates between `api-1:3000`, `api-2:3000`, `api-3:3000`.

---

## Production equivalent

| Local (Phase 4) | AWS Production |
|-----------------|----------------|
| nginx round-robin | AWS ALB round-robin |
| `/ready` health check path | ALB target group health check path: `/ready` |
| `docker stop dfs-api-2` | ECS task crash / EC2 instance failure |
| nginx `max_fails=3 fail_timeout=30s` | ALB health check: 3 consecutive failures → deregister |
| 3 containers on 1 host | 3 ECS tasks across 3 AZs |

---

## Troubleshooting

**Request fails immediately after kill (request 16 returns non-201):**
nginx has not yet detected the failed upstream. The `proxy_next_upstream`
config will retry the request on a healthy upstream. If you still see a
failure, re-run the test — occasional races on request 16 are expected
and are eliminated in production by ALB's health check deregistration delay.

**`/ready` returns `s3: fail`:**
LocalStack may not have created the S3 bucket. Check:
```bash
docker compose logs localstack | grep "bucket"
```
