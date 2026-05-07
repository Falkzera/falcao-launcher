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
KNOWN_HOSTS="${MONITOR_PUSH_KNOWN_HOSTS:-}"

# Strict host key checking quando known_hosts pinado é fornecido (CI).
# Em dev local, accept-new é OK (já bateu na VM antes).
if [[ -n "$KNOWN_HOSTS" && -f "$KNOWN_HOSTS" ]]; then
  SSH_OPTS=(-o "UserKnownHostsFile=$KNOWN_HOSTS" -o "StrictHostKeyChecking=yes")
else
  SSH_OPTS=(-o "StrictHostKeyChecking=accept-new")
fi

# CSV format: ts,endpoint,status_code,response_ms,ok,error
# Usa \COPY (client-side) — psql lê CSV do próprio stdin. Como o stdin do psql
# é o stdin da SSH session (graças ao docker exec -i), basta concatenar:
#   1. linha "\COPY ... FROM STDIN ..."
#   2. CSV bruto
#   3. terminator "\."
# Captura output em var pra detectar erros do psql (SSH retorna 0 mesmo se psql falhar).
SSH_OUTPUT=$({
  echo "\\COPY health_checks (ts, endpoint, status_code, response_ms, ok, error) FROM STDIN WITH (FORMAT csv, NULL '');"
  cat "$CSV"
  echo "\\."
} | ssh -i "$SSH_KEY" \
       "${SSH_OPTS[@]}" \
       -o BatchMode=yes \
       "$SSH_USER@$SSH_HOST" 2>&1)

echo "$SSH_OUTPUT"

# Validação pós-push: SSH retorna 0 mesmo quando psql parsing falha. Detectamos
# via grep ERROR/FATAL no output. Em sucesso, output tem "COPY <N>" onde N>0.
if echo "$SSH_OUTPUT" | grep -qE "^(ERROR|FATAL)"; then
  echo "✗ psql reportou erro — push falhou" >&2
  exit 1
fi
if ! echo "$SSH_OUTPUT" | grep -qE "^COPY [1-9]"; then
  echo "✗ output do psql não contém 'COPY <N>' com N>0 — push pode não ter inserido nada" >&2
  exit 1
fi
echo "✓ push OK"
