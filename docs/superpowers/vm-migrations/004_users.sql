-- Cria roles separados (princípio do menor privilégio)
-- ATENÇÃO: senhas são substituídas em runtime; não armazenadas no repo
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
