import type { MetricPoint } from "../types/monitor";

/**
 * Converte amostras de um counter cumulativo em rate (unidade por segundo).
 *
 * Descarta pontos onde:
 *  - delta de valor é negativo (counter wrap, ex: VM rebootou e zerou tx_bytes)
 *  - intervalo de tempo é zero ou negativo
 *  - prev ou curr value é null
 *
 * Retorna array vazio se houver menos de 2 pontos.
 */
export function toRate(points: MetricPoint[]): MetricPoint[] {
  if (points.length < 2) return [];
  const out: MetricPoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev.value === null || curr.value === null) continue;
    if (!Number.isFinite(prev.value) || !Number.isFinite(curr.value)) continue;
    const dt =
      (new Date(curr.ts).getTime() - new Date(prev.ts).getTime()) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const dv = curr.value - prev.value;
    if (!Number.isFinite(dv) || dv < 0) continue; // counter wrap or non-finite
    out.push({ ts: curr.ts, value: dv / dt });
  }
  return out;
}
