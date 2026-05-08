// Helpers de formatação reutilizáveis (bytes, etc.)

export function fmtBytes(bytes: number): string {
  if (bytes >= 1099511627776) return `${(bytes / 1099511627776).toFixed(2)} TB`;
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Bytes/segundo adaptativo. Escolhe unidade pela magnitude pra evitar
 * "0.00 MB/s" empilhado quando taxa é baixa.
 */
export function fmtBytesPerSec(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return "—";
  if (bps >= 1073741824) return `${(bps / 1073741824).toFixed(2)} GB/s`;
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  if (bps >= 1) return `${bps.toFixed(0)} B/s`;
  return `${(bps * 1024).toFixed(2)} KB/s ÷ 1024`; // valores < 1 B/s viram fração de KB/s pra leitura
}

/**
 * Tick formatter inteligente baseado no nome da métrica.
 * Usado pelo AnalysisChartSlot YAxis (que recebe métricas heterogêneas).
 *
 * Heurística por sufixo do nome:
 *   *_bytes     → fmtBytes (RAM, disco, traffic)
 *   *_pct       → "X.X %"
 *   load_*      → "X.XX"
 *   cost_*      → "$ X.XX"
 *   *_ms        → "X ms"
 *   default     → "X.XX"
 */
export function formatByMetricName(metricName: string, value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (metricName.endsWith("_bytes")) return fmtBytes(value);
  if (metricName.endsWith("_pct")) return `${value.toFixed(1)}%`;
  if (metricName.startsWith("load_")) return value.toFixed(2);
  if (metricName.startsWith("cost_")) return `$${value.toFixed(2)}`;
  if (metricName.endsWith("_ms")) return `${value.toFixed(0)} ms`;
  return value.toFixed(2);
}

/**
 * Threshold de cor pra progress bars seguindo decisão do CTO:
 * <70% success, 70-90% warning, >=90% danger.
 */
export function pickProgressColor(pct: number): string {
  if (pct >= 90) return "var(--color-danger)";
  if (pct >= 70) return "var(--color-warning)";
  return "var(--color-success)";
}

/**
 * Formato relativo curto pra timestamps recentes.
 * "há 5s", "há 2m", "há 1h", "há 3d".
 */
export function formatRelative(ts: Date): string {
  const diffMs = Date.now() - ts.getTime();
  if (diffMs < 0) return "agora";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `há ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `há ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `há ${hr}h`;
  const day = Math.floor(hr / 24);
  return `há ${day}d`;
}

/**
 * Cor pro display de uptime %.
 * ≥99.9 verde, ≥99 amarelo, <99 vermelho.
 */
export function pickUptimeColor(pct: number): string {
  if (pct >= 99.9) return "var(--color-success)";
  if (pct >= 99) return "var(--color-warning)";
  return "var(--color-danger)";
}
