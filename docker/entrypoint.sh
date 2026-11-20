#!/bin/sh
# Generates /etc/nginx/conf.d/default.conf from the template, substituting:
#   - __APP_PORT__       : port nginx listens on (default 80)
#   - __METRICS_LOCATION__ : the path the app polls (derived from the URL's path)
#   - __METRICS_PROXY__    : the absolute URL to the metrics endpoint
#   - __HOST_METRICS_PROXY__ : absolute URL to the in-container hoststats sidecar
#   - __AUTH_PROXY__       : absolute URL to the in-container auths sidecar
#   - __RETAINER_PROXY__   : absolute URL to the in-container retainer sidecar
set -eu

APP_PORT="${APP_PORT:-80}"
METRICS_URL="${METRICS_URL:-http://127.0.0.1:18982/metrics}"
HOST_METRICS_URL="${HOST_METRICS_URL:-http://127.0.0.1:9340/metrics}"
AUTH_URL="${AUTH_URL:-http://127.0.0.1:9341}"
RETAINER_URL="${RETAINER_URL:-http://127.0.0.1:9342}"

# Normalize scheme
case "${METRICS_URL}" in
  http://*|https://*)
    scheme="${METRICS_URL%%://*}"
    rest="${METRICS_URL#*://}"
    ;;
  *)
    scheme="http"
    rest="${METRICS_URL}"
    ;;
esac

# Split host:port from path (path defaults to /metrics when absent)
case "${rest}" in
  */*)
    hp="${rest%%/*}"
    p="/${rest#*/}"
    ;;
  *)
    hp="${rest}"
    p="/metrics"
    ;;
esac

# Strip trailing slash for a stable location/proxy pair (1:1 path mapping)
p_ns="${p%/}"
[ -n "${p_ns}" ] || p_ns=""
loc="/${p_ns#/}"
proxy="${scheme}://${hp}${p_ns}"

# auth URL is used bare (proxy_pass <url>/authz and proxy_pass <url>), so strip
# a trailing slash to avoid a double slash.
auth_url="${AUTH_URL%/}"

sed -e "s|__APP_PORT__|${APP_PORT}|g" \
    -e "s|__METRICS_LOCATION__|${loc}|g" \
    -e "s|__METRICS_PROXY__|${proxy}|g" \
    -e "s|__HOST_METRICS_PROXY__|${HOST_METRICS_URL}|g" \
    -e "s|__AUTH_PROXY__|${auth_url}|g" \
    -e "s|__RETAINER_PROXY__|${RETAINER_URL}|g" \
    /opt/pulse/nginx.conf.template > /etc/nginx/conf.d/default.conf

# Start the auth sidecar (SQLite), the host telemetry sidecar, and the
# history recaller (SQLite) in the background; nginx proxies /api/* + /__auth
# -> auths, /api/history/* -> retainer, and /host-metrics -> hoststats.
/opt/pulse/auths &
/opt/pulse/hoststats &
/opt/pulse/retainer &

# Wait for auths to open its port (busybox wget, no curl/nc on alpine); fall
# back to a short fixed delay. nginx's auth_request subrequests fail-closed
# (401) until auths answers, so the endpoints stay gated the whole time.
i=0
while [ "$i" -lt 50 ]; do
  if wget "${auth_url}/healthz" 2>/dev/null; then break; fi
  i=$((i + 1))
  sleep 0.2
done

echo "[pulse] listening on :${APP_PORT} | proxying ${loc} -> ${proxy} | host-metrics -> ${HOST_METRICS_URL} | auths -> ${auth_url}"
exec nginx -g "daemon off;"
