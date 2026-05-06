-- Habilita compressão (configura segmentação por dimensões)
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'host, source, resource, metric'
);

-- Comprime chunks após 7 dias automaticamente
SELECT add_compression_policy('metrics', INTERVAL '7 days');

-- Apaga raw data com mais de 35 dias (continuous aggregates preservam histórico)
SELECT add_retention_policy('metrics', INTERVAL '35 days');
