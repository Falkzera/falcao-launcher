import { useEffect, useMemo, useState } from "react";
import { monitorApi, useTunnel, usePolling } from "../lib/monitor";
import { InlineLoading } from "./Loading";
import { SecurityScanProgress } from "./SecurityScanProgress";
import { VulnerabilityRow } from "./VulnerabilityRow";
import {
  shouldRevalidateDismiss,
  vulnDismissKey,
  type DismissedVuln,
  type VulnFilters,
  type VulnKind,
  type VulnSeverity,
  type VulnerabilityRow as VulnRow,
} from "../types/security";

const DEFAULT_FILTERS: VulnFilters = {
  severities: ["critical", "high"],
  kinds: ["deps", "image", "advisory"],
  search: "",
};

const SEV_LABEL: Record<VulnSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
};

const KIND_LABEL: Record<VulnKind, string> = {
  deps: "deps",
  image: "image",
  advisory: "advisory",
};

export function SecurityTab() {
  const { ready } = useTunnel();
  const [filters, setFilters] = useState<VulnFilters>(DEFAULT_FILTERS);
  const [scanning, setScanning] = useState(false);
  const [dismissed, setDismissed] = useState<Record<string, DismissedVuln>>({});

  const { data: vulns, error: vulnsError } = usePolling(
    () => monitorApi.listVulnerabilities(filters),
    60_000,
    ready,
  );
  const { data: summary } = usePolling(monitorApi.vulnSummary, 60_000, ready);

  const refreshDismissed = () => {
    monitorApi
      .listDismissedCves()
      .then(setDismissed)
      .catch((e) => console.warn("listDismissedCves failed:", e));
  };
  useEffect(() => {
    refreshDismissed();
  }, []);

  const visibleVulns = useMemo(() => {
    if (!vulns) return null;
    return vulns.filter((v) => {
      const key = vulnDismissKey(v);
      const d = dismissed[key];
      if (!d) return true;
      return shouldRevalidateDismiss(v, d);
    });
  }, [vulns, dismissed]);

  const grouped = useMemo(() => {
    if (!visibleVulns) return null;
    const map = new Map<string, VulnRow[]>();
    for (const v of visibleVulns) {
      if (!map.has(v.source_id)) map.set(v.source_id, []);
      map.get(v.source_id)!.push(v);
    }
    for (const [, list] of map) {
      list.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    }
    return Array.from(map.entries()).sort();
  }, [visibleVulns]);

  const handleScan = async () => {
    setScanning(true);
    try {
      await Promise.allSettled([
        monitorApi.triggerTrivyScan(),
        monitorApi.triggerDependabotScan(),
      ]);
    } finally {
      setScanning(false);
    }
  };

  const toggleSeverity = (sev: VulnSeverity) => {
    setFilters((prev) => ({
      ...prev,
      severities: prev.severities.includes(sev)
        ? prev.severities.filter((s) => s !== sev)
        : [...prev.severities, sev],
    }));
  };

  const toggleKind = (k: VulnKind) => {
    setFilters((prev) => ({
      ...prev,
      kinds: prev.kinds.includes(k)
        ? prev.kinds.filter((x) => x !== k)
        : [...prev.kinds, k],
    }));
  };

  const handleDismiss = async (vuln: VulnRow) => {
    const key = vulnDismissKey(vuln);
    await monitorApi.dismissCve(key, vuln.fix_version);
    refreshDismissed();
  };

  const handleUndismiss = async (vuln: VulnRow) => {
    const key = vulnDismissKey(vuln);
    await monitorApi.undismissCve(key);
    refreshDismissed();
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3">
        <div className="flex flex-wrap gap-3 text-sm">
          {summary ? (
            <>
              <SummaryCount label="Critical" count={summary.critical} color="danger" />
              <SummaryCount label="High" count={summary.high} color="warning" />
              <SummaryCount label="Medium" count={summary.medium} color="accent-secondary" />
              <SummaryCount label="Low" count={summary.low} color="text-muted" />
              {summary.last_scan && (
                <span className="text-xs text-[var(--color-text-muted)]">
                  · última coleta:{" "}
                  {new Date(summary.last_scan).toLocaleString("pt-BR")}
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-[var(--color-text-muted)]">carregando…</span>
          )}
        </div>
        <button
          onClick={handleScan}
          disabled={scanning || !ready}
          className="rounded-md bg-[var(--color-accent-primary)] px-3 py-1 text-xs font-semibold text-black transition hover:bg-[var(--color-accent-secondary)] disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "🔄 Re-escanear agora"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--color-text-secondary)]">Severidade:</span>
        {(["critical", "high", "medium", "low"] as VulnSeverity[]).map((sev) => (
          <FilterChip
            key={sev}
            label={SEV_LABEL[sev]}
            active={filters.severities.includes(sev)}
            onToggle={() => toggleSeverity(sev)}
          />
        ))}
        <span className="ml-3 text-[var(--color-text-secondary)]">Kind:</span>
        {(["deps", "image", "advisory"] as VulnKind[]).map((k) => (
          <FilterChip
            key={k}
            label={KIND_LABEL[k]}
            active={filters.kinds.includes(k)}
            onToggle={() => toggleKind(k)}
          />
        ))}
      </div>

      {vulnsError && !vulns && (
        <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          Erro: {String(vulnsError)}
        </div>
      )}

      {!vulns && (
        <InlineLoading
          minHeight="9rem"
          messages={[
            "Lendo vulnerabilidades",
            "Calculando dedup por CVE",
            "Cruzando com dismisseds",
            "Quase lá",
          ]}
        />
      )}

      {grouped && grouped.length === 0 && (
        <div className="rounded-2xl border border-dashed border-[var(--color-border-default)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
          🎉 Nenhuma vulnerabilidade ativa nos filtros atuais.
        </div>
      )}

      {grouped && grouped.length > 0 && (
        <div className="space-y-4">
          {grouped.map(([source, list]) => (
            <section key={source} className="space-y-2">
              <h3 className="font-mono text-sm font-semibold text-[var(--color-text-primary)]">
                {source}{" "}
                <span className="text-[var(--color-text-muted)]">
                  ({list.length})
                </span>
              </h3>
              <div className="space-y-1.5">
                {list.map((v) => {
                  const key = vulnDismissKey(v);
                  return (
                    <VulnerabilityRow
                      key={key + v.last_seen}
                      vuln={v}
                      isDismissed={key in dismissed}
                      onDismiss={() => handleDismiss(v)}
                      onUndismiss={() => handleUndismiss(v)}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <SecurityScanProgress
        scanning={scanning}
        onClose={() => setScanning(false)}
      />
    </div>
  );
}

function severityRank(s: string): number {
  const order: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    unknown: 4,
  };
  return order[s] ?? 5;
}

function SummaryCount({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: "danger" | "warning" | "accent-secondary" | "text-muted";
}) {
  return (
    <span className="font-mono">
      <span className="text-[var(--color-text-muted)]">{label}:</span>{" "}
      <span style={{ color: `var(--color-${color})` }}>{count}</span>
    </span>
  );
}

function FilterChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={
        "rounded-full border px-2 py-0.5 text-[10px] font-mono transition " +
        (active
          ? "border-[var(--color-accent-primary)] bg-[var(--color-accent-primary)]/15 text-[var(--color-accent-primary)]"
          : "border-[var(--color-border-subtle)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]")
      }
    >
      {label}
    </button>
  );
}
