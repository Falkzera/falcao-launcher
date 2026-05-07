#!/usr/bin/env bash
# Probeia endpoints externos e gera CSV em stdout.
# Uso: ./probe-endpoints.sh > /tmp/results.csv
#
# Output: ts,endpoint,status_code,response_ms,ok,error
# - ts: ISO 8601 UTC com timezone
# - status_code: HTTP code ou "" se não respondeu
# - response_ms: int ou "" se não respondeu
# - ok: "t" ou "f" (Postgres boolean format)
# - error: "" ou um de [timeout, dns, ssl, connection_refused, http_<code>]

set -uo pipefail

ENDPOINTS=(
  "https://falcao-financas.duckdns.org/api/health"
  "https://falcao-financas.vercel.app"
  "https://162.55.217.189"
)

probe() {
  local url="$1"
  local out rc
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)

  # -k pra aceitar cert mismatch (endpoint #3 bate IP direto, sem SNI)
  # -m 10 timeout 10s
  # -sS silencia progress mas mostra erros
  # -w "%{http_code} %{time_total}" formata stdout
  # SEM -f: queremos registrar 4xx/5xx como dado, não como erro
  set +e
  out=$(curl -ksS -o /dev/null -m 10 -w "%{http_code} %{time_total}" "$url" 2>/dev/null)
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    local status_code response_s response_ms
    status_code=$(echo "$out" | awk '{print $1}')
    response_s=$(echo "$out" | awk '{print $2}')
    response_ms=$(awk -v s="$response_s" 'BEGIN{ printf "%d", s*1000 }')
    if [[ "$status_code" -ge 200 && "$status_code" -lt 300 ]]; then
      echo "$now,$url,$status_code,$response_ms,t,"
    else
      echo "$now,$url,$status_code,$response_ms,f,http_$status_code"
    fi
  else
    local err="error_$rc"
    case "$rc" in
      6)  err="dns" ;;
      7)  err="connection_refused" ;;
      28) err="timeout" ;;
      35|60) err="ssl" ;;
    esac
    echo "$now,$url,,,f,$err"
  fi
}

# Roda em paralelo, captura outputs em arquivos temporários
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

for i in "${!ENDPOINTS[@]}"; do
  probe "${ENDPOINTS[$i]}" > "$TMPDIR/$i.csv" &
done
wait

# Output em ordem dos endpoints
for i in "${!ENDPOINTS[@]}"; do
  cat "$TMPDIR/$i.csv"
done
