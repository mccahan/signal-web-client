#!/usr/bin/env sh
# Boot a built image and prove the things a base-image change could silently
# break. The runtime base is a moving tag, so this is the gate that stops a new
# Node major from reaching a deployment.
#
#   ./scripts/smoke-test.sh <image>
set -eu

IMAGE="${1:-signal-web-client:latest}"
NAME="swc-smoke-$$"
PORT="${SMOKE_PORT:-18080}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1"
  echo "--- container logs ---"
  docker logs "$NAME" 2>&1 | tail -30 || true
  exit 1
}

echo "==> smoke testing $IMAGE"

# Resolve the node binary from the image rather than hardcoding a path, so a
# base-image swap produces an accurate failure instead of a misleading one.
NODE_BIN=$(docker inspect "$IMAGE" --format '{{index .Config.Entrypoint 0}}' 2>/dev/null || true)
[ -n "$NODE_BIN" ] || fail "image has no entrypoint; expected the base to provide node"
case "$NODE_BIN" in
  *node) : ;;
  *) fail "unexpected entrypoint '$NODE_BIN'; expected a node binary" ;;
esac
echo "    node binary: $NODE_BIN"

# 1. node:sqlite must exist and work — it is the entire storage layer, and the
#    runtime base is a moving tag, so a major bump is exactly what could change
#    it out from under us.
docker run --rm --entrypoint "$NODE_BIN" "$IMAGE" -e "
  const { DatabaseSync, backup } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(a TEXT)');
  db.prepare('INSERT INTO t VALUES(?)').run('ok');
  if (db.prepare('SELECT a FROM t').get().a !== 'ok') throw new Error('query failed');
  if (typeof backup !== 'function') throw new Error('sqlite backup() missing — backups would break');
  db.exec(\"VACUUM INTO '/tmp/smoke.db'\");
  console.log('    node:sqlite ok on ' + process.version);
" || fail "node:sqlite is unusable on this base image"

# 2. It must run as a non-root user.
UID_IN_IMAGE=$(docker run --rm --entrypoint "$NODE_BIN" "$IMAGE" -e "process.stdout.write(String(process.getuid()))")
[ "$UID_IN_IMAGE" != "0" ] || fail "image runs as root"
echo "    runs as uid $UID_IN_IMAGE"

# 3. It must boot and serve. No Signal API is reachable here, which is itself
#    worth testing: the server should still come up and report the outage.
docker run -d --name "$NAME" -p "$PORT:8080" \
  -e SIGNAL_API_URL=http://127.0.0.1:9 \
  -e AUTH_PASSWORD=smoke \
  "$IMAGE" >/dev/null

i=0
until curl -fsS "http://127.0.0.1:$PORT/api/session" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 45 ] || fail "server did not become ready within 45s"
  sleep 1
done
echo "    HTTP up after ${i}s"

# 4. The auth gate must hold, and the UI shell must be served.
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me")
[ "$code" = "401" ] || fail "expected 401 from /api/me without a session, got $code"
echo "    auth gate returns 401"

code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$code" = "200" ] || fail "expected 200 for the app shell, got $code"
echo "    app shell served"

# 5. The database must be writable as the non-root user on the volume path.
docker logs "$NAME" 2>&1 | grep -q "database ready" || fail "database was not initialised (check /data permissions)"
echo "    database initialised in /data"

echo "==> smoke test passed"
