// Tipos do monitor da VM. Casam com structs Rust em src-tauri/src/monitor/queries.rs.
// Tauri serializa em snake_case por padrão — manter exatamente como no backend.

export interface VmStatus {
  last_heartbeat: string | null;
  agent_version: string | null;
  last_cpu_pct: number | null;
  last_mem_pct: number | null;
  last_mem_used_bytes: number | null;
  last_mem_total_bytes: number | null;
  last_disk_used_bytes: number | null;
  last_disk_avail_bytes: number | null;
  last_hetzner_outgoing_bytes: number | null;
  last_hetzner_included_bytes: number | null;
  cost_accumulated_usd: number | null;
  vm_age_hours: number | null;
}

export interface ContainerInfo {
  name: string;
  last_cpu_pct: number | null;
  last_mem_pct: number | null;
  last_seen: string | null;
  last_mem_used_bytes: number | null;
  last_mem_limit_bytes: number | null;
}

export interface MetricPoint {
  ts: string;
  value: number | null;
}

export type MetricSource = "vm" | "container" | "hetzner";

export type MetricBucket = "1 minute" | "5 minutes" | "1 hour" | "1 day" | null;

export type WindowKey = "1h" | "6h" | "24h" | "7d" | "30d";

export interface HealthCheckSummary {
  endpoint: string;
  last_ts: string | null;
  last_ok: boolean | null;
  last_status_code: number | null;
  last_response_ms: number | null;
  last_error: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  uptime_30d: number | null;
  avg_response_ms_24h: number | null;
}
