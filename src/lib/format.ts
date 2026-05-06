// Helpers de formatação reutilizáveis (bytes, etc.)

export function fmtBytes(bytes: number): string {
  if (bytes >= 1099511627776) return `${(bytes / 1099511627776).toFixed(2)} TB`;
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Threshold de cor pra progress bars seguindo decisão do CTO:
 * <70% success, 70-90% warning, >=90% danger.
 *
 * --color-warning hoje colide visualmente com --color-accent-primary
 * (ambos #f59e0b), então usamos #eab308 inline pra warning ter um amarelo
 * distinto do amber do brand.
 */
export function pickProgressColor(pct: number): string {
  if (pct >= 90) return "var(--color-danger)";
  if (pct >= 70) return "#eab308";
  return "var(--color-success)";
}
