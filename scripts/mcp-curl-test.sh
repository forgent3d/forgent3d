#!/usr/bin/env bash
# Use curl over Streamable HTTP: initialize -> notifications/initialized -> tools/call list_models
# Usage: start Forgent3D Previewer first (default MCP port 41234), then run at repo root:
#   bash scripts/mcp-curl-test.sh
# Or: MCP_URL=http://127.0.0.1:41234/mcp bash scripts/mcp-curl-test.sh
# Optional end-session call: curl -X DELETE -H "mcp-session-id: $SESSION" -H "mcp-protocol-version: $PROTO" "$URL"

set -euo pipefail

URL="${MCP_URL:-http://127.0.0.1:41234/mcp}"
H_ACCEPT='Accept: application/json, text/event-stream'
H_JSON='Content-Type: application/json'
PROTO='2025-03-26'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
HDR1="$TMP/h1.txt"
BODY1="$TMP/b1.txt"

echo "POST initialize → $URL" >&2
curl -sS -D "$HDR1" -o "$BODY1" -X POST "$URL" \
  -H "$H_ACCEPT" -H "$H_JSON" \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$PROTO\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl-test\",\"version\":\"1.0\"}}}"

SESSION=$(grep -i '^mcp-session-id:' "$HDR1" | tr -d '\r' | awk 'NF>1 {print $2}' | tail -1)
if [[ -z "${SESSION:-}" ]]; then
  echo "Error: no mcp-session-id in response headers. initialize may have failed." >&2
  echo "--- response headers ---" >&2
  cat "$HDR1" >&2 || true
  echo "--- response body (SSE) ---" >&2
  cat "$BODY1" >&2 || true
  exit 1
fi

echo "mcp-session-id: $SESSION" >&2
echo "--- initialize response body (SSE) ---" >&2
cat "$BODY1" >&2
echo "" >&2

echo "POST notifications/initialized" >&2
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$URL" \
  -H "$H_ACCEPT" -H "$H_JSON" \
  -H "mcp-session-id: $SESSION" \
  -H "mcp-protocol-version: $PROTO" \
  --data-binary '{"jsonrpc":"2.0","method":"notifications/initialized"}')
echo "HTTP $CODE (expected 202)" >&2

HDR3="$TMP/h3.txt"
BODY3="$TMP/b3.txt"
echo "POST tools/call list_models" >&2
curl -sS -D "$HDR3" -o "$BODY3" -X POST "$URL" \
  -H "$H_ACCEPT" -H "$H_JSON" \
  -H "mcp-session-id: $SESSION" \
  -H "mcp-protocol-version: $PROTO" \
  --data-binary '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_models","arguments":{}}}'

echo "--- list_models response body (SSE) ---" >&2
cat "$BODY3" >&2
echo "" >&2

echo "=== JSON from data: lines (for easy copy) ==="
grep '^data: ' "$BODY3" | sed 's/^data: //' || true
