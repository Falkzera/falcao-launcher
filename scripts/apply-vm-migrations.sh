#!/usr/bin/env bash
# Aplica migrations versionadas em /opt/falcao-monitor/migrations/ na VM Hetzner.
# Idempotente: usa tabela schema_migrations no Postgres pra rastrear o que já foi aplicado.
#
# Uso:
#   ./scripts/apply-vm-migrations.sh                      Aplica migrations pendentes
#   ./scripts/apply-vm-migrations.sh --mark-applied-only  Marca todas como aplicadas SEM rodar
#                                                         (use 1x na primeira vez em DB já populado)
#   ./scripts/apply-vm-migrations.sh --dry-run            Lista o que aplicaria sem executar
#
# Cada migration roda numa transação atômica:
#   - copia o arquivo pro container via `docker cp`
#   - psql com ON_ERROR_STOP=1 executa BEGIN; \i <file>; INSERT INTO schema_migrations; COMMIT
# Se qualquer comando falhar, o BEGIN dá rollback e a migration NÃO é marcada como aplicada.

set -euo pipefail

VM_HOST="${VM_HOST:-falcao@162.55.217.189}"
MIGRATIONS_DIR="/opt/falcao-monitor/migrations"

MODE="apply"
case "${1:-}" in
  --mark-applied-only) MODE="mark" ;;
  --dry-run)           MODE="dry" ;;
  "")                  ;;
  *) echo "Unknown flag: $1"; exit 1 ;;
esac

echo "==> Ensuring schema_migrations table exists on VM"
ssh "$VM_HOST" "docker exec -i falcao-monitor-db psql -U postgres -d falcao_monitor -v ON_ERROR_STOP=1" <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

echo "==> Computing pending migrations"
PENDING=$(ssh "$VM_HOST" "
  set -e
  cd '$MIGRATIONS_DIR'
  files=\$(ls -1 *.sql 2>/dev/null | sort)
  applied=\$(docker exec -i falcao-monitor-db psql -U postgres -d falcao_monitor -tAc \
    'SELECT filename FROM schema_migrations ORDER BY filename')
  for f in \$files; do
    echo \"\$applied\" | grep -qx \"\$f\" || echo \"\$f\"
  done
")

if [[ -z "${PENDING// }" ]]; then
  echo "✓ All migrations already applied"
  exit 0
fi

echo ""
echo "Pending migrations:"
echo "$PENDING" | sed 's/^/  - /'
echo ""

case "$MODE" in
  dry)
    echo "(dry-run, nothing applied)"
    exit 0
    ;;
  mark)
    echo "Marking pending migrations as applied WITHOUT running them..."
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      ssh "$VM_HOST" "docker exec -i falcao-monitor-db psql -U postgres -d falcao_monitor -v ON_ERROR_STOP=1 -c \"INSERT INTO schema_migrations (filename) VALUES ('$f') ON CONFLICT DO NOTHING;\""
      echo "  marked $f"
    done <<< "$PENDING"
    exit 0
    ;;
  apply)
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      echo ""
      echo ">>> Applying $f"
      # Atomic per-migration: copia arquivo, abre psql session com BEGIN/COMMIT, ON_ERROR_STOP cuida de rollback
      ssh "$VM_HOST" "
        set -euo pipefail
        docker cp '$MIGRATIONS_DIR/$f' falcao-monitor-db:/tmp/migration.sql
        docker exec -i falcao-monitor-db psql -U postgres -d falcao_monitor -v ON_ERROR_STOP=1 <<EOF
BEGIN;
\\i /tmp/migration.sql
INSERT INTO schema_migrations (filename) VALUES ('$f');
COMMIT;
EOF
        docker exec falcao-monitor-db rm -f /tmp/migration.sql
      "
      echo "    ✓ applied $f"
    done <<< "$PENDING"
    echo ""
    echo "✓ All pending migrations applied"
    ;;
esac
