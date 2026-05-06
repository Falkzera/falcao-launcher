# Phase A — Validation

Executado em 2026-05-06T14:39:25Z.

- TimescaleDB extension: ativa (versão 2.26.4)
- Hypertable: metrics
- Continuous aggregates: metrics_hourly, metrics_daily (criados, refresh policy ativa)
- Users: monitor_writer (INSERT only), monitor_reader (SELECT only)
- Validação isolation: writer não lê, reader não escreve. ✅
- Imagem usada: `timescale/timescaledb-ha:pg16` (a tag `pg16-latest` do plano original foi descontinuada no Docker Hub; `pg16` é o equivalente atual).
