-- Tabela única heterogênea pra vulnerabilidades (Sprint B1 — Snyk-like).
-- Discriminator `kind`: 'deps' (Dependabot), 'image' (Trivy), 'advisory' (GHSA cross-cutting).
-- Hypertable TimescaleDB pra retention/compression uniforme com o resto.
CREATE TABLE IF NOT EXISTS vulnerabilities (
  ts            TIMESTAMPTZ NOT NULL,
  kind          TEXT        NOT NULL,
  severity      TEXT        NOT NULL,
  cve_id        TEXT,
  ghsa_id       TEXT,
  source_id     TEXT        NOT NULL,
  package_name  TEXT,
  package_version TEXT,
  fix_version   TEXT,
  title         TEXT,
  url           TEXT,
  state         TEXT        NOT NULL,
  raw           JSONB
);

SELECT create_hypertable('vulnerabilities', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_vuln_lookup
  ON vulnerabilities (kind, severity, source_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_vuln_open_critical
  ON vulnerabilities (severity, ts DESC)
  WHERE state = 'open' AND severity IN ('critical', 'high');

ALTER TABLE vulnerabilities SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'kind, source_id'
);

SELECT add_compression_policy('vulnerabilities', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('vulnerabilities', INTERVAL '90 days', if_not_exists => TRUE);

GRANT SELECT ON vulnerabilities TO monitor_reader;
GRANT INSERT, SELECT ON vulnerabilities TO monitor_writer;
