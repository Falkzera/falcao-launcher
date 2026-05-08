// Tipos do "Snyk-like" (Sprint B1). Espelham structs Rust em
// src-tauri/src/monitor/security.rs e src-tauri/src/config.rs.

export type VulnSeverity = "critical" | "high" | "medium" | "low" | "unknown";
export type VulnKind = "deps" | "image" | "advisory";
export type VulnState = "open" | "fixed" | "dismissed";

export interface VulnerabilityRow {
  kind: VulnKind;
  severity: VulnSeverity;
  cve_id: string | null;
  ghsa_id: string | null;
  source_id: string;
  package_name: string | null;
  package_version: string | null;
  fix_version: string | null;
  title: string | null;
  url: string | null;
  state: VulnState;
  last_seen: string; // ISO
}

export interface VulnSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  last_scan: string | null;
}

export interface DismissedVuln {
  fix_version_at_time: string | null;
  dismissed_at: string;
}

export interface VulnFilters {
  severities: VulnSeverity[];
  kinds: VulnKind[];
  search: string;
}

/** Constrói chave canônica pra dismiss (formato Rust: "source_id:cve_id"). */
export function vulnDismissKey(vuln: VulnerabilityRow): string {
  const id = vuln.cve_id ?? vuln.ghsa_id ?? vuln.package_name ?? "unknown";
  return `${vuln.source_id}:${id}`;
}

/** Verifica se um CVE dismissed deve ser revalidado (fix_version mudou). */
export function shouldRevalidateDismiss(
  vuln: VulnerabilityRow,
  dismissed: DismissedVuln,
): boolean {
  return (vuln.fix_version ?? null) !== (dismissed.fix_version_at_time ?? null);
}
