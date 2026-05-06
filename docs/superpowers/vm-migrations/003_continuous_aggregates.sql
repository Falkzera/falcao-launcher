-- Agregado por hora
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket,
       host, source, resource, metric,
       avg(value) AS avg_value,
       max(value) AS max_value,
       min(value) AS min_value,
       count(*)   AS n
FROM metrics
GROUP BY bucket, host, source, resource, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_hourly',
  start_offset      => INTERVAL '1 month',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

-- Agregado por dia
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', ts) AS bucket,
       host, source, resource, metric,
       avg(value) AS avg_value,
       max(value) AS max_value,
       min(value) AS min_value,
       count(*)   AS n
FROM metrics
GROUP BY bucket, host, source, resource, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_daily',
  start_offset      => INTERVAL '1 year',
  end_offset        => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day');
