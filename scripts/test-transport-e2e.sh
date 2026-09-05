#!/bin/zsh
set -euo pipefail

root=$(mktemp -d /tmp/qujing-tailcat-e2e.XXXXXX)
http_pid= server_pid= connector_pid= unauthorized_pid=
cleanup() {
  [[ -n "${unauthorized_pid}" ]] && kill "$unauthorized_pid" 2>/dev/null || true
  [[ -n "${connector_pid}" ]] && kill "$connector_pid" 2>/dev/null || true
  [[ -n "${server_pid}" ]] && kill "$server_pid" 2>/dev/null || true
  [[ -n "${http_pid}" ]] && kill "$http_pid" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

binary=${QUJING_TRANSPORT_BIN:-apps/cli/native/transport/bin/qujing-transport}
before=$(tailscale debug prefs 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)
"$binary" key-create --output "$root/peer.json" > "$root/key.out"
public_key=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["publicKey"])' "$root/key.out")
python3 -m http.server 43220 --bind 127.0.0.1 --directory "$root" >"$root/http.log" 2>&1 & http_pid=$!
start_server() {
  rm -f "$root/server.out" "$root/server.err"
  "$binary" serve --key "$root/server.json" --port 43220 --allow "$public_key" >"$root/server.out" 2>"$root/server.err" & server_pid=$!
  for _ in {1..80}; do
    [[ -s "$root/server.out" ]] && return
    kill -0 "$server_pid" 2>/dev/null || { cat "$root/server.err"; exit 1; }
    sleep .5
  done
  echo "Tailcat server readiness timeout" >&2
  exit 1
}
start_connector() {
  rm -f "$root/connector.out" "$root/connector.err"
  "$binary" connect --server "$server_address" --port 43220 --key "$root/peer.json" --listen 127.0.0.1:43221 >"$root/connector.out" 2>"$root/connector.err" & connector_pid=$!
  for _ in {1..80}; do
    [[ -s "$root/connector.out" ]] && return
    kill -0 "$connector_pid" 2>/dev/null || { cat "$root/connector.err"; exit 1; }
    sleep .25
  done
  echo "Connector readiness timeout" >&2
  exit 1
}
start_server
server_address=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["serverAddress"])' "$root/server.out")
start_connector

if ! body=$(curl --fail --silent --show-error --max-time 40 http://127.0.0.1:43221/); then
  echo "initial authorized connection failed" >&2
  cat "$root/server.err" "$root/connector.err" >&2
  exit 1
fi
[[ "$body" == *"Directory listing"* ]]

"$binary" key-create --output "$root/unauthorized.json" > /dev/null
"$binary" connect --server "$server_address" --port 43220 --key "$root/unauthorized.json" --listen 127.0.0.1:43222 >"$root/unauthorized.out" 2>"$root/unauthorized.err" & unauthorized_pid=$!
for _ in {1..40}; do [[ -s "$root/unauthorized.out" ]] && break; sleep .1; done
if curl --fail --silent --max-time 3 http://127.0.0.1:43222/ >/dev/null 2>&1; then
  echo "unallowlisted key connected" >&2
  exit 1
fi
kill "$unauthorized_pid" 2>/dev/null || true
wait "$unauthorized_pid" 2>/dev/null || true
unauthorized_pid=

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
start_server
restarted_address=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["serverAddress"])' "$root/server.out")
[[ "$server_address" == "$restarted_address" ]]
if ! curl --fail --silent --show-error --max-time 40 -H 'Connection: close' http://127.0.0.1:43221/ >/dev/null; then
  echo "Server restart recovery failed" >&2
  cat "$root/server.err" "$root/connector.err" >&2
  exit 1
fi

kill "$connector_pid"
wait "$connector_pid" 2>/dev/null || true
start_connector
if ! curl --fail --silent --show-error --max-time 40 http://127.0.0.1:43221/ >/dev/null; then
  echo "Connector restart recovery failed" >&2
  cat "$root/server.err" "$root/connector.err" >&2
  exit 1
fi

after=$(tailscale debug prefs 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)
[[ "$before" == "$after" ]]
[[ "$(stat -f '%Lp' "$root/server.json" 2>/dev/null || stat -c '%a' "$root/server.json")" == "600" ]]
[[ "$(stat -f '%Lp' "$root/peer.json" 2>/dev/null || stat -c '%a' "$root/peer.json")" == "600" ]]
echo "transport e2e: ok"
