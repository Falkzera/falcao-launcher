-- Tabela dedicada pra deploys da Vercel.
-- Heterogênea (texto + timestamps + status enum), não cabe em metrics genérica.
-- Sprint 2 (2026-05-07) — Vercel stacks design.
CREATE TABLE IF NOT EXISTS vercel_deployments (
  ts            TIMESTAMPTZ NOT NULL,
  project_id    TEXT        NOT NULL,
  project_name  TEXT        NOT NULL,
  deployment_id TEXT        NOT NULL,
  state         TEXT        NOT NULL,
  url           TEXT,
  prod_url      TEXT,
  branch        TEXT,
  commit_sha    TEXT,
  commit_msg    TEXT,
  author        TEXT,
  created_at    TIMESTAMPTZ,
  ready_at      TIMESTAMPTZ,
  build_ms      INT
);

SELECT create_hypertable('vercel_deployments', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_vercel_deployments_lookup
  ON vercel_deployments (project_name, ts DESC);

CREATE INDEX IF NOT EXISTS idx_vercel_deployments_deployment_id
  ON vercel_deployments (deployment_id);

ALTER TABLE vercel_deployments SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_name'
);

SELECT add_compression_policy('vercel_deployments', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('vercel_deployments', INTERVAL '90 days', if_not_exists => TRUE);

-- Grants alinhados com tabelas existentes (writer/reader roles).
GRANT SELECT ON vercel_deployments TO monitor_reader;
GRANT INSERT, SELECT ON vercel_deployments TO monitor_writer;
