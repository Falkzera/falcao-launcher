// Serializa o AnalysisContext (Sprint 3) num prompt Markdown estruturado pra
// ser consumido como primeira mensagem da conversa do Claude Code (Sprint 4).
// Truncamento defensivo evita estouro de contexto em ranges longos.

import type { AnalysisContext, MetricRef } from "../types/analysis";

const MAX_POINTS_PER_CHART = 1000;
const MAX_LOG_CHARS = 200_000;

/**
 * Serializa o `AnalysisContext` em prompt Markdown estruturado pro Claude
 * Code consumir como primeira mensagem da conversa.
 *
 * Template:
 *   # Investigação · <métrica primária> · <ISO timestamp>
 *   ## Contexto
 *   ## Métricas observadas (uma seção por chart, série em CSV)
 *   ## Logs do período
 *   ## Pergunta
 *
 * Truncamento defensivo:
 *   - Séries com > MAX_POINTS_PER_CHART são truncadas com nota
 *   - Logs > MAX_LOG_CHARS são truncados com nota
 */
export function serializeContextToMarkdown(
  context: AnalysisContext,
  question: string,
): string {
  const sections: string[] = [];

  const primaryLabel = formatMetricLabel(context.charts[0]?.metric);
  const now = new Date().toISOString();
  sections.push(`# Investigação · ${primaryLabel} · ${now}`);

  sections.push(formatContextSection(context));
  sections.push(formatMetricsSection(context));

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

function formatMetricsSection(context: AnalysisContext): string {
  const lines: string[] = ["## Métricas observadas", ""];

  for (const chart of context.charts) {
    const label = formatMetricLabel(chart.metric);
    const bucket = chart.bucket ?? "raw";
    const totalPoints = chart.series.length;

    lines.push(`### ${label}`);
    lines.push(`Bucket: ${bucket} · ${totalPoints} pontos`);
    lines.push("");
    lines.push("```csv");
    lines.push("ts,value");

    const truncated = totalPoints > MAX_POINTS_PER_CHART;
    const points = truncated
      ? chart.series.slice(0, MAX_POINTS_PER_CHART)
      : chart.series;

    for (const p of points) {
      lines.push(`${p.ts},${p.value ?? ""}`);
    }
    if (truncated) {
      lines.push(`... (truncated, ${totalPoints} pontos no total)`);
    }

    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function formatLogsSection(context: AnalysisContext): string {
  const lines: string[] = [];
  const containerLabel = context.logs.container ?? "(sem container)";
  lines.push(`## Logs do período · container: ${containerLabel}`);
  lines.push("");

  let text = context.logs.text ?? "";
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
export function estimatePromptSize(context: AnalysisContext): {
  bytes: number;
  charts: number;
  logLines: number;
} {
  let bytes = 1000;
  let logLines = 0;

  for (const chart of context.charts) {
    bytes += Math.min(chart.series.length, MAX_POINTS_PER_CHART) * 30;
    bytes += 100;
  }

  if (context.logs.text != null) {
    const text = context.logs.text.slice(0, MAX_LOG_CHARS);
    bytes += text.length;
    logLines = text.split("\n").length;
  }

  return { bytes, charts: context.charts.length, logLines };
}
