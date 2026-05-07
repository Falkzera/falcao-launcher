#!/usr/bin/env bash
# Pipeia o CSV de probe-endpoints.sh pra o Postgres da VM via SSH dedicada.
# Uso: ./push-health-results.sh [results.csv]
#       ./probe-endpoints.sh | ./push-health-results.sh
#
# A SSH key tem command="docker exec -i falcao-monitor-db psql -U monitor_writer -d falcao_monitor"
# então qualquer stdin via SSH cai direto no psql da VM.

set -euo pipefail

CSV="${1:-/dev/stdin}"
SSH_KEY="${MONITOR_PUSH_SSH_KEY_PATH:-$HOME/.ssh/falcao-monitor-push}"
SSH_HOST="${MONITOR_PUSH_HOST:-162.55.217.189}"
SSH_USER="${MONITOR_PUSH_USER:-falcao}"

# CSV format: ts,endpoint,status_code,response_ms,ok,error
# Usa \COPY (client-side) — psql lê CSV do próprio stdin. Como o stdin do psql
# é o stdin da SSH session (graças ao docker exec -i), basta concatenar:
#   1. linha "\COPY ... FROM STDIN ..."
#   2. CSV bruto
#   3. terminator "\."
{
  echo "\\COPY health_checks (ts, endpoint, status_code, response_ms, ok, error) FROM STDIN WITH (FORMAT csv, NULL '');"
  cat "$CSV"
  echo "\\."
} | ssh -i "$SSH_KEY" \
       -o StrictHostKeyChecking=accept-new \
       -o BatchMode=yes \
       "$SSH_USER@$SSH_HOST"
