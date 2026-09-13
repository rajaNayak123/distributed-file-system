#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TOTAL_REQUESTS=40
EMAIL="crash-test-$(date +%s)@example.com"
PASSWORD="Password123!"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
fail() { echo -e "${RED}✗ $*${NC}"; }
info() { echo -e "${CYAN}▶ $*${NC}"; }

info "Checking stack is up..."
if ! curl -sf "$BASE_URL/health" > /dev/null; then
  fail "Stack not reachable at $BASE_URL — run: docker compose up --build -d"
  exit 1
fi
ok "Stack is up"

READY=$(curl -sf "$BASE_URL/ready" | jq -r '.status')
if [ "$READY" != "ready" ]; then
  fail "/ready returned non-ready — check docker compose logs"
  exit 1
fi
ok "/ready is healthy"

info "Registering test user: $EMAIL"
curl -sf -X POST "$BASE_URL/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" > /dev/null
ok "Registered"

info "Logging in..."
TOKEN=$(curl -sf -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | jq -r '.accessToken')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  fail "Login failed — no token returned"
  exit 1
fi
ok "Got JWT"

SUCCESSES=0
FAILURES=0

info "Firing $TOTAL_REQUESTS upload-initiation requests..."
info "api-2 will be stopped after the first 15 requests."
echo ""

for i in $(seq 1 $TOTAL_REQUESTS); do
  if [ "$i" -eq 16 ]; then
    info ">>> Stopping dfs-api-2 mid-traffic (simulating crash)..."
    docker stop dfs-api-2 > /dev/null 2>&1 || true
    info ">>> dfs-api-2 stopped. Remaining requests should still succeed."
    echo ""
  fi

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$BASE_URL/uploads" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"fileName\":\"test-$i.pdf\",\"contentType\":\"application/pdf\",\"size\":1024}" \
    2>/dev/null)

  if [ "$HTTP_CODE" = "201" ]; then
    SUCCESSES=$((SUCCESSES + 1))
    echo -e "  Request $i: ${GREEN}$HTTP_CODE OK${NC}"
  else
    FAILURES=$((FAILURES + 1))
    echo -e "  Request $i: ${RED}$HTTP_CODE FAIL${NC}"
  fi
done

echo ""
echo "────────────────────────────────────────"
info "Results:"
echo "  Total:    $TOTAL_REQUESTS"
ok  "  Success:  $SUCCESSES"
if [ "$FAILURES" -gt 0 ]; then
  fail "  Failures: $FAILURES"
else
  ok  "  Failures: 0"
fi
echo "────────────────────────────────────────"

if [ "$FAILURES" -eq 0 ]; then
  echo ""
  ok "PASS — All $TOTAL_REQUESTS requests succeeded despite killing api-2 mid-traffic."
  echo "       The load balancer automatically routed around the failed instance."
else
  echo ""
  fail "FAIL — $FAILURES request(s) failed. Check docker compose logs for details."
  exit 1
fi

echo ""
info "Restarting dfs-api-2 to restore full capacity..."
docker start dfs-api-2 > /dev/null 2>&1 || true
ok "dfs-api-2 restarted"
