// Serializa o AnalysisContext (Sprint 3) num prompt Markdown estruturado pra
// ser consumido como primeira mensagem da conversa do Claude Code (Sprint 4).
// Truncamento defensivo evita estouro de contexto em ranges longos.
//
// Polish batch A:
//   - A1: modo "summary" (estatísticas + picos) reduz prompt em ~70%.
//   - A2: redação automática de tokens/keys nos logs antes de embutir.

import type { AnalysisContext, MetricRef } from "../types/analysis";

const MAX_POINTS_PER_CHART = 1000;
const MAX_LOG_CHARS = 200_000;

/** Modo de serialização das séries. */
export type SerializationMode = "raw" | "summary";

// --- A2: padrões de redação aplicados em logs antes de virar prompt -------
// Ordem importa: padrões mais específicos antes dos genéricos (hex catch-all).
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens — preserva o "Bearer " + redact o valor
  [/(\bBearer\s+)([A-Za-z0-9._\-+=/]{8,})/gi, "$1[REDACTED]"],
  // password= / api_key= / secret= / token= em config/query strings
  [
    /((?:password|api_?key|secret|token)\s*[=:]\s*)["']?([^"'\s&]{4,})["']?/gi,
    '$1"[REDACTED]"',
  ],
  // AWS access keys (AKIA + 16 chars)
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED-AWS-KEY]"],
  // Anthropic / OpenAI style keys (sk-ant-..., sk-proj-...)
  [/\b(sk-[a-z]+-[A-Za-z0-9_\-]{16,})\b/g, "[REDACTED-API-KEY]"],
  // JWT (3 base64 chunks separados por ponto, header começa em eyJ)
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED-JWT]"],
  // Strings hex longas (32+ chars) — possíveis hashes/keys/MD5/SHA
  [/\b[a-f0-9]{32,}\b/gi, "[REDACTED-HEX]"],
];

/** Aplica todos os SENSITIVE_PATTERNS em ordem. Sempre ligado (segurança first). */
function redactSensitive(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Serializa o `AnalysisContext` em prompt Markdown estruturado pro Claude
 * Code consumir como primeira mensagem da conversa.
 *
 * Template:
 *   # Investigação · <métrica primária> · <ISO timestamp>
 *   ## Contexto
 *   ## Métricas observadas (uma seção por chart, série em CSV ou resumo estatístico)
 *   ## Logs do período (com tokens redacted)
 *   ## Pergunta
 *
 * Truncamento defensivo:
 *   - Séries com > MAX_POINTS_PER_CHART são truncadas com nota (modo raw)
 *   - Logs > MAX_LOG_CHARS são truncados com nota
 *
 * @param mode "raw" envia CSV de pontos crus (default, compat). "summary" envia
 *             min/max/avg/p50/p95 + até 3 picos (>2σ acima da média).
 */
export function serializeContextToMarkdown(
  context: AnalysisContext,
  question: string,
  mode: SerializationMode = "raw",
): string {
  const sections: string[] = [];

  const primaryLabel = formatMetricLabel(context.charts[0]?.metric);
  const now = new Date().toISOString();
  sections.push(`# Investigação · ${primaryLabel} · ${now}`);

  sections.push(formatContextSection(context));
  sections.push(formatMetricsSection(context, mode));

  if (context.logs.text != null) {
    sections.push(formatLogsSection(context));
  }

  sections.push(
    `## Pergunta\n\n${question.trim() || "(sem pergunta — analise os dados acima)"}`,
  );
  sections.push("---\n\n*Investigação gerada pelo falcao-launcher · modo análise*");

  return sections.join("\n\n");
}

function formatMetricLabel(metric: MetricRef | undefined): string {
  if (!metric) return "(sem métrica)";
  if (metric.kind === "container") {
    return `container ${metric.resource} · ${metric.metric}`;
  }
  return `${metric.kind.toUpperCase()} · ${metric.metric}`;
}

function formatContextSection(context: AnalysisContext): string {
  const lines: string[] = ["## Contexto", ""];

  const startIso = context.range.start.toISOString();
  const endIso = context.range.end.toISOString();
  const durationMs = context.range.end.getTime() - context.range.start.getTime();
  const durationMin = Math.round(durationMs / 60_000);

  lines.push(`- **Range:** ${startIso} → ${endIso} (${durationMin} min)`);
  lines.push(`- **Preset:** ${context.preset} carregado`);
  lines.push(`- **Layout:** ${context.layout.name ?? "rascunho não salvo"}`);
  lines.push(`- **Charts visíveis:** ${context.charts.length}`);

  return lines.join("\n");
}

function formatMetricsSection(
  context: AnalysisContext,
  mode: SerializationMode,
): string {
  const lines: string[] = ["## Métricas observadas", ""];

  for (const chart of context.charts) {
    const label = formatMetricLabel(chart.metric);
    const bucket = chart.bucket ?? "raw";
    const totalPoints = chart.series.length;

    lines.push(`### ${label}`);
    lines.push(`Bucket: ${bucket} · ${totalPoints} pontos`);
    lines.push("");

    if (mode === "summary") {
      lines.push(...formatChartSummary(chart.series));
    } else {
      lines.push(...formatChartCsv(chart.series, totalPoints));
    }

    lines.push("");
  }

  return lines.join("\n");
}

/** Modo raw: bloco CSV truncado em MAX_POINTS_PER_CHART. */
function formatChartCsv(
  series: Array<{ ts: string; value: number | null }>,
  totalPoints: number,
): string[] {
  const lines: string[] = [];
  lines.push("```csv");
  lines.push("ts,value");

  const truncated = totalPoints > MAX_POINTS_PER_CHART;
  const points = truncated ? series.slice(0, MAX_POINTS_PER_CHART) : series;

  for (const p of points) {
    lines.push(`${p.ts},${p.value ?? ""}`);
  }
  if (truncated) {
    lines.push(`... (truncated, ${totalPoints} pontos no total)`);
  }

  lines.push("```");
  return lines;
}

/**
 * Modo summary: estatísticas descritivas + picos.
 * Picos = pontos com value > avg + 2*stddev, ordenados por value desc, top 3.
 */
function formatChartSummary(
  series: Array<{ ts: string; value: number | null }>,
): string[] {
  const lines: string[] = ["Resumo estatístico:"];

  // Filtra nulos (gaps de coleta) — eles existem mas não entram em estatística
  const valid = series.filter(
    (p): p is { ts: string; value: number } =>
      p.value !== null && p.value !== undefined && Number.isFinite(p.value),
  );

  if (valid.length === 0) {
    lines.push("- (série sem dados válidos)");
    return lines;
  }

  const values = valid.map((p) => p.value);
  const sorted = [...values].sort((a, b) => a - b);

  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);

  // Acha quando min/max ocorreram (primeiro match — pode haver empates)
  const minPoint = valid.find((p) => p.value === min)!;
  const maxPoint = valid.find((p) => p.value === max)!;

  lines.push(`- min: ${formatNum(min)} (em ${minPoint.ts})`);
  lines.push(`- max: ${formatNum(max)} (em ${maxPoint.ts})`);
  lines.push(`- avg: ${formatNum(avg)}`);
  lines.push(`- p50: ${formatNum(p50)}`);
  lines.push(`- p95: ${formatNum(p95)}`);

  // Picos: > avg + 2*stddev
  const variance =
    values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  const threshold = avg + 2 * stddev;

  const peaks = valid
    .filter((p) => p.value > threshold)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  if (peaks.length > 0) {
    const peaksStr = peaks
      .map((p) => `${p.ts} (${formatNum(p.value)})`)
      .join(", ");
    lines.push(`- ${peaks.length} pico${peaks.length !== 1 ? "s" : ""} (>2σ acima da média): ${peaksStr}`);
  } else {
    lines.push("- nenhum pico (>2σ acima da média)");
  }

  return lines;
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  // Interpolação linear
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function formatNum(n: number): string {
  // 2 casas decimais, sem trailing zero pra inteiros redondos
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}

function formatLogsSection(context: AnalysisContext): string {
  const lines: string[] = [];
  const containerLabel = context.logs.container ?? "(sem container)";
  lines.push(`## Logs do período · container: ${containerLabel}`);
  lines.push("");

  // A2: redact tokens/keys ANTES do truncamento — segurança first.
  let text = redactSensitive(context.logs.text ?? "");
  let truncated = false;

  if (text.length > MAX_LOG_CHARS) {
    text = text.slice(0, MAX_LOG_CHARS);
    truncated = true;
  }

  lines.push("```");
  lines.push(text);
  if (truncated) {
    lines.push("... (truncated by launcher — refine o range pra ver mais)");
  }
  if (context.logs.truncated) {
    lines.push("... (também truncated em 2000 linhas pelo docker --tail)");
  }
  lines.push("```");

  return lines.join("\n");
}

/** Estima tamanho do prompt sem gerar ele inteiro — usado pra preview no modal. */
export function estimatePromptSize(
  context: AnalysisContext,
  mode: SerializationMode = "raw",
): {
  bytes: number;
  charts: number;
  logLines: number;
  mode: SerializationMode;
} {
  let bytes = 1000;
  let logLines = 0;

  for (const chart of context.charts) {
    if (mode === "summary") {
      // ~500 bytes por chart: header + 5 estatísticas + linha de picos
      bytes += 500;
    } else {
      bytes += Math.min(chart.series.length, MAX_POINTS_PER_CHART) * 30;
      bytes += 100;
    }
  }

  if (context.logs.text != null) {
    const text = context.logs.text.slice(0, MAX_LOG_CHARS);
    bytes += text.length;
    logLines = text.split("\n").length;
  }

  return { bytes, charts: context.charts.length, logLines, mode };
}
