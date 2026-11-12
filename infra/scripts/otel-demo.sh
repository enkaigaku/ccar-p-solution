#!/usr/bin/env bash
# Fetch and run the OpenTelemetry Demo at a pinned version.
# Usage: infra/scripts/otel-demo.sh [up|down|status]
#
# The demo runs its core compose file plus our compose.extras.yaml, which attaches the demo's
# collector to Incident Copilot's observability network and forwards all demo telemetry to the
# otel-gateway there (Tempo / Loki / Prometheus / Grafana). Start infra/observability first.
set -euo pipefail

OTEL_DEMO_VERSION="3.1.0"
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="$here/.otel-demo"
extras="$here/observability/otel-demo"
compose=(docker compose -f compose.yaml -f compose.extras.yaml)

# The demo's .env pins DEMO_VERSION=latest, which pulls images built from the demo's main branch
# while the compose file and collector config come from the tag. Those drift apart (main's
# recommendation is a Java rewrite that exports OTLP/HTTP to 4318, but the 3.1.0 compose points
# it at gRPC 4317), so pin the images to the checked-out tag. Shell variables override .env.
export DEMO_VERSION="$OTEL_DEMO_VERSION" IMAGE_VERSION="$OTEL_DEMO_VERSION"

if [ ! -d "$dir" ]; then
  git clone --depth 1 --branch "$OTEL_DEMO_VERSION" https://github.com/open-telemetry/opentelemetry-demo.git "$dir"
fi

# Overwrite the demo's two documented customization seams with ours on every run, so edits under
# infra/observability/otel-demo take effect on the next `up`.
install_extras() {
  cp "$extras/compose.extras.yaml" "$dir/compose.extras.yaml"
  cp "$extras/otelcol-config-extras.yml" "$dir/src/otel-collector/otelcol-config-extras.yml"
}

cd "$dir"
case "${1:-up}" in
  up)
    if ! docker network inspect incident-observability >/dev/null 2>&1; then
      echo "network incident-observability not found: run 'docker compose -f infra/observability/compose.yaml up -d' first" >&2
      exit 1
    fi
    install_extras
    "${compose[@]}" up -d
    ;;
  down) "${compose[@]}" down ;;
  status) "${compose[@]}" ps ;;
  *) echo "usage: $0 [up|down|status]" >&2; exit 2 ;;
esac
