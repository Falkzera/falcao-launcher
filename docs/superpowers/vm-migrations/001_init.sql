-- Habilita extensão TimescaleDB
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Cria tabela principal de métricas (modelo wide)
CREATE TABLE IF NOT EXISTS metrics (
  ts        TIMESTAMPTZ NOT NULL,
  host      TEXT NOT NULL,
  source    TEXT NOT NULL,
  resource  TEXT,
  metric    TEXT NOT NULL,
  value     DOUBLE PRECISION,
  labels    JSONB
);

-- Converte em hypertable (chunking automático por 7 dias)
SELECT create_hypertable('metrics', 'ts', if_not_exists => TRUE);

-- Índice principal pra queries do launcher
CREATE INDEX IF NOT EXISTS idx_metrics_lookup
  ON metrics (host, source, resource, metric, ts DESC);

-- Heartbeat do agente (pra detectar coletor parado)
CREATE TABLE IF NOT EXISTS agent_heartbeat (
  host         TEXT PRIMARY KEY,
  last_seen    TIMESTAMPTZ NOT NULL,
  agent_version TEXT
);
