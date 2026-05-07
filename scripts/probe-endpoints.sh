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

# Cada endpoint tem flag opcional "k" pra aceitar cert mismatch.
# Só endpoint #3 (IP direto, sem SNI) precisa — os outros DEVEM validar cert
# (senão MITM passaria silencioso).
ENDPOINTS=(
  "https://falcao-financas.duckdns.org/api/health"
  "https://falcao-financas.vercel.app"
  "https://162.55.217.189|k"
)

probe() {
  local entry="$1"
  local url="${entry%%|*}"
  local flags="${entry#*|}"
  [[ "$flags" == "$entry" ]] && flags=""  # sem |

  local out rc
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)

  # -m 10 timeout 10s
  # -sS silencia progress mas mostra erros
  # -w "%{http_code} %{time_total}" formata stdout
  # SEM -f: queremos registrar 4xx/5xx como dado, não como erro
  # -k SÓ se entry tiver flag "k" (endpoint #3 com cert mismatch esperado)
  local curl_opts=(-sS -o /dev/null -m 10 -w "%{http_code} %{time_total}")
  [[ "$flags" == *k* ]] && curl_opts+=(-k)

  set +e
  out=$(curl "${curl_opts[@]}" "$url" 2>/dev/null)
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

# Output em ordem dos endpoints. URL no CSV é só a URL (sem o "|k" flag).
for i in "${!ENDPOINTS[@]}"; do
  cat "$TMPDIR/$i.csv"
done
