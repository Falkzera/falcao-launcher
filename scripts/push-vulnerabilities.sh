#!/usr/bin/env bash
# Pipeia CSV de vulnerabilidades pro Postgres da VM via SSH dedicada.
# Reusa a mesma SSH key da Sprint 2 (falcao-monitor-push) — command-restricted
# ao psql do monitor_writer, então qualquer stdin via SSH cai no psql.
#
# Uso: ./scan-dependabot.sh | ./push-vulnerabilities.sh
#       ./push-vulnerabilities.sh results.csv

set -euo pipefail

CSV="${1:-/dev/stdin}"
SSH_KEY="${MONITOR_PUSH_SSH_KEY_PATH:-$HOME/.ssh/falcao-monitor-push}"
SSH_HOST="${MONITOR_PUSH_HOST:-162.55.217.189}"
SSH_USER="${MONITOR_PUSH_USER:-falcao}"
KNOWN_HOSTS="${MONITOR_PUSH_KNOWN_HOSTS:-}"

if [[ -n "$KNOWN_HOSTS" && -f "$KNOWN_HOSTS" ]]; then
  SSH_OPTS=(-o "UserKnownHostsFile=$KNOWN_HOSTS" -o "StrictHostKeyChecking=yes")
else
  SSH_OPTS=(-o "StrictHostKeyChecking=accept-new")
fi

# Concatena: \COPY command + CSV body + terminator \.
{
  echo "\\COPY vulnerabilities(ts,kind,severity,cve_id,ghsa_id,source_id,package_name,package_version,fix_version,title,url,state) FROM STDIN WITH (FORMAT csv, HEADER true)"
  cat "$CSV"
  echo "\\."
} | ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "$SSH_USER@$SSH_HOST"
