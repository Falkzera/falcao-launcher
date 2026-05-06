// Tipos do monitor da VM. Casam com structs Rust em src-tauri/src/monitor/queries.rs.
// Tauri serializa em snake_case por padrão — manter exatamente como no backend.

export interface VmStatus {
  last_heartbeat: string | null;
  agent_version: string | null;
  last_cpu_pct: number | null;
  last_mem_pct: number | null;
}

export interface ContainerInfo {
  name: string;
  last_cpu_pct: number | null;
  last_mem_pct: number | null;
  last_seen: string | null;
}

export interface MetricPoint {
  ts: string;
  value: number | null;
}

export type MetricSource = "vm" | "container" | "hetzner";

export type MetricBucket = "1 minute" | "5 minutes" | "1 hour" | "1 day" | null;
