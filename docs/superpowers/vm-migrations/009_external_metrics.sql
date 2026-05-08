-- Sprint B3 — Monitor de custos multi-serviço.
-- Hypertable única heterogênea: serviço externo + métrica + valor + quota.
-- Compartilha shape entre Vercel, GH Actions e Hetzner (espelhado).
CREATE TABLE IF NOT EXISTS external_metrics (
  ts            TIMESTAMPTZ NOT NULL,
  service       TEXT        NOT NULL,    -- 'vercel' | 'gh_actions' | 'hetzner'
  metric        TEXT        NOT NULL,    -- 'bandwidth_bytes' | 'build_minutes' | etc
  value         DOUBLE PRECISION NOT NULL,
  quota         DOUBLE PRECISION,        -- limite do free tier (NULL = sem free tier)
  unit          TEXT        NOT NULL,    -- 'bytes' | 'minutes' | 'count' | 'usd'
  period_start  TIMESTAMPTZ,             -- início do mês de billing
  PRIMARY KEY (ts, service, metric)
);

SELECT create_hypertable('external_metrics', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_external_metrics_lookup
  ON external_metrics (service, metric, ts DESC);

ALTER TABLE external_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'service, metric'
);

SELECT add_compression_policy('external_metrics', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('external_metrics', INTERVAL '90 days', if_not_exists => TRUE);

GRANT SELECT ON external_metrics TO monitor_reader;
GRANT INSERT, SELECT ON external_metrics TO monitor_writer;
