#!/bin/sh
# Generates /etc/nginx/conf.d/default.conf from the template, substituting:
#   - __APP_PORT__       : port nginx listens on (default 80)
#   - __METRICS_LOCATION__ : the path the app polls (derived from the URL's path)
#   - __METRICS_PROXY__    : the absolute URL to the metrics endpoint
set -eu

APP_PORT="${APP_PORT:-80}"
METRICS_URL="${METRICS_URL:-http://127.0.0.1:18982/metrics}"

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

sed -e "s|__APP_PORT__|${APP_PORT}|g" \
    -e "s|__METRICS_LOCATION__|${loc}|g" \
    -e "s|__METRICS_PROXY__|${proxy}|g" \
    /opt/pulse/nginx.conf.template > /etc/nginx/conf.d/default.conf

echo "[pulse] listening on :${APP_PORT} | proxying ${loc} -> ${proxy}"
exec nginx -g "daemon off;"
