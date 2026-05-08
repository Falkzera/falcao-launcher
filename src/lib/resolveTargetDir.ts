// Resolve o diretório onde o Claude Code deve ser spawnado pra investigação
// (Sprint 4). Convenção: nome do container == nome do projeto em ~/Projects.

import type { MetricRef } from "../types/analysis";

/**
 * Decide em qual diretório o Claude Code deve abrir baseado na métrica
 * primária da investigação.
 *
 * Convenção: nome do container Docker == nome do projeto local em ~/Projects.
 *   - container.resource = "falcao-financas" → ~/Projects/falcao-financas
 *   - kind vm/hetzner → fallback ~/Projects/falcao-launcher (overall context)
 *
 * O home é hardcoded pra Falcão. Se for portar pra outra máquina, mover pra
 * config (ex: monitorApi.getHomeDir() retorna do Rust).
 *
 * O Rust faz fallback automático ao launcher dir se este diretório não existe
 * — frontend não precisa checar fs.
 */
const HOME = "/home/falcao";

export function resolveTargetDir(metric: MetricRef): string {
  if (metric.kind === "container") {
    return `${HOME}/Projects/${metric.resource}`;
  }
  return `${HOME}/Projects/falcao-launcher`;
}
