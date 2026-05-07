-- Tabela principal de health checks (probe externo via GH Actions cron)
CREATE TABLE IF NOT EXISTS health_checks (
  ts            TIMESTAMPTZ      NOT NULL,
  endpoint      TEXT             NOT NULL,
  status_code   INT,
  response_ms   INT,
  ok            BOOLEAN          NOT NULL,
  error         TEXT
);

SELECT create_hypertable('health_checks', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_health_checks_lookup
  ON health_checks (endpoint, ts DESC);

ALTER TABLE health_checks SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'endpoint'
);

SELECT add_compression_policy('health_checks', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('health_checks', INTERVAL '90 days', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS health_checks_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket,
       endpoint,
       count(*)                                                  AS total,
       count(*) FILTER (WHERE ok)                                AS up,
       100.0 * count(*) FILTER (WHERE ok) / NULLIF(count(*), 0)  AS uptime_pct,
       avg(response_ms) FILTER (WHERE ok)                        AS avg_response_ms,
       max(response_ms) FILTER (WHERE ok)                        AS max_response_ms
FROM health_checks
GROUP BY bucket, endpoint
WITH NO DATA;

SELECT add_continuous_aggregate_policy('health_checks_hourly',
  start_offset      => INTERVAL '7 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes',
  if_not_exists     => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS health_checks_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', ts) AS bucket,
       endpoint,
       count(*)                                                  AS total,
       count(*) FILTER (WHERE ok)                                AS up,
       100.0 * count(*) FILTER (WHERE ok) / NULLIF(count(*), 0)  AS uptime_pct,
       avg(response_ms) FILTER (WHERE ok)                        AS avg_response_ms
FROM health_checks
GROUP BY bucket, endpoint
WITH NO DATA;

SELECT add_continuous_aggregate_policy('health_checks_daily',
  start_offset      => INTERVAL '90 days',
  end_offset        => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);
