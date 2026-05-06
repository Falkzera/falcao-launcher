-- ⚠️ TEMPLATE — NÃO APLICAR DIRETAMENTE
--
-- Este arquivo é uma versão SANITIZADA da migration 004 com placeholders no
-- lugar das senhas. Postgres NÃO interpola variáveis em .sql; rodar este
-- arquivo direto criaria roles com senha literal "${MONITOR_WRITER_PASSWORD}".
--
-- Pra aplicar de verdade na VM, renderizar com substituição shell:
--   envsubst < 004_users.sql > /tmp/004_users.rendered.sql
--   docker exec -i falcao-monitor-db psql -U postgres -d falcao_monitor < /tmp/004_users.rendered.sql
--
-- Variáveis de ambiente esperadas: MONITOR_WRITER_PASSWORD, MONITOR_READER_PASSWORD.
--
-- A versão real (já renderizada) vive em /opt/falcao-monitor/migrations/ na VM,
-- com senhas inline. Esta cópia no repo serve só pra rastreabilidade do schema.

-- Cria roles separados (princípio do menor privilégio)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_writer') THEN
    CREATE ROLE monitor_writer LOGIN PASSWORD '${MONITOR_WRITER_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_reader') THEN
    CREATE ROLE monitor_reader LOGIN PASSWORD '${MONITOR_READER_PASSWORD}';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE falcao_monitor TO monitor_writer;
GRANT USAGE ON SCHEMA public TO monitor_writer;
GRANT INSERT ON metrics, agent_heartbeat TO monitor_writer;
GRANT UPDATE ON agent_heartbeat TO monitor_writer;

GRANT CONNECT ON DATABASE falcao_monitor TO monitor_reader;
GRANT USAGE ON SCHEMA public TO monitor_reader;
GRANT SELECT ON metrics, agent_heartbeat, metrics_hourly, metrics_daily TO monitor_reader;
