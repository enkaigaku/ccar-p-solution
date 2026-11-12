#!/usr/bin/env bash
# Fetch and run the OpenTelemetry Demo at a pinned version.
# Usage: infra/scripts/otel-demo.sh [up|down|status]
set -euo pipefail

OTEL_DEMO_VERSION="3.1.0"
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="$here/.otel-demo"

if [ ! -d "$dir" ]; then
  git clone --depth 1 --branch "$OTEL_DEMO_VERSION" https://github.com/open-telemetry/opentelemetry-demo.git "$dir"
fi

cd "$dir"
case "${1:-up}" in
  up) docker compose up -d ;;
  down) docker compose down ;;
  status) docker compose ps ;;
  *) echo "usage: $0 [up|down|status]" >&2; exit 2 ;;
esac
