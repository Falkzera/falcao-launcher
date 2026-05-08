// Tipos do "modo análise" (Sprint 3). Espelham as decisões D6 (schema layouts)
// e D7 (hook context). Schema versionado pra migração futura.

import type { MetricBucket, MetricPoint, WindowKey } from "./monitor";

/**
 * Versão do schema de layouts persistido em localStorage.
 * Bump aqui quando mudar shape do `LayoutsBundle` ou `AnalysisLayout`.
 */
export const ANALYSIS_SCHEMA_VERSION = 1;

/** Chave do localStorage onde o bundle vive. */
export const LAYOUTS_STORAGE_KEY = "analysis:layouts:v1";

/**
 * Referência a uma métrica disponível.
 * Discriminated union por `kind` — cada branch tem fields obrigatórios diferentes:
 *   - vm: só metric (não tem resource)
 *   - container: precisa do resource (nome do container)
 *   - hetzner: só metric
 */
export type MetricRef =
  | { kind: "vm"; metric: string }
  | { kind: "container"; resource: string; metric: string }
  | { kind: "hetzner"; metric: string };

/** Slot individual no grid drag-drop (coords em unidades do react-grid-layout). */
export interface ChartSlot {
  id: string;       // uuid v4
  x: number;
  y: number;
  w: number;
  h: number;
  metric: MetricRef;
}

/** Layout salvo de uma análise (presets + grid completo). */
export interface AnalysisLayout {
  id: string;
  name: string;
  created_at: string;     // ISO 8601
  updated_at: string;
  default_preset: WindowKey;
  charts: ChartSlot[];
}

/** Bundle completo persistido em localStorage. */
export interface LayoutsBundle {
  version: 1;
  layouts: AnalysisLayout[];
  last_used_id: string | null;
}

/**
 * Estado consumível por integrações futuras (Sprint 4 — Claude).
 * Tudo serializável pra JSON. Sem refs DOM, sem promises pendentes.
 */
export interface AnalysisContext {
  range: { start: Date; end: Date };
  preset: WindowKey;
  charts: Array<{
    metric: MetricRef;
    bucket: MetricBucket;
    series: MetricPoint[];
  }>;
  logs: {
    container: string | null;
    fetched_for: { start: Date; end: Date } | null;
    text: string | null;
    truncated: boolean;
  };
  layout: { id: string | null; name: string | null };
}

/**
 * Resposta do comando Rust `monitor_fetch_logs_range`.
 * Espelha `LogsRangeResponse` em commands.rs.
 */
export interface LogsRangeResponse {
  text: string;
  truncated: boolean;
  line_count: number;
}

/**
 * Cria bundle default vazio (usado em first-load ou após corrupção).
 */
export function createDefaultBundle(): LayoutsBundle {
  return {
    version: ANALYSIS_SCHEMA_VERSION,
    layouts: [],
    last_used_id: null,
  };
}
