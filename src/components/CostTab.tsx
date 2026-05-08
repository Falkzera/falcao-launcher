import { useMemo } from "react";
import { monitorApi, usePolling, useTunnel } from "../lib/monitor";
import { InlineLoading } from "./Loading";
import { CostHistoryChart } from "./CostHistoryChart";
import { CostServiceCard } from "./CostServiceCard";
import type { CostService, CostUsage } from "../types/costs";

const SERVICES: CostService[] = ["vercel", "gh_actions", "hetzner"];

export function CostTab() {
  const { ready, error: tunnelErr } = useTunnel();
  const { data: summary, error } = usePolling(monitorApi.costSummary, 60_000, ready);

  const grouped = useMemo(() => {
    if (!summary) return null;
    const map: Record<CostService, CostUsage[]> = {
      vercel: [],
      gh_actions: [],
      hetzner: [],
    };
    for (const m of summary) {
      const svc = m.service as CostService;
      if (svc in map) map[svc].push(m);
    }
    return map;
  }, [summary]);

  return (
    <div className="space-y-5">
      {tunnelErr && (
        <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          Tunnel SSH: {tunnelErr}
        </div>
      )}
      {error && summary == null && (
        <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          Erro: {String(error)}
        </div>
      )}

      {!summary && (
        <InlineLoading
          minHeight="9rem"
          messages={[
            "Buscando uso Vercel",
            "Lendo billing GitHub",
            "Cruzando com Hetzner",
            "Quase lá",
          ]}
        />
      )}

      {grouped && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {SERVICES.map((s) => (
              <CostServiceCard key={s} service={s} metrics={grouped[s]} />
            ))}
          </div>
          <CostHistoryChart summary={summary ?? []} ready={ready} />
        </>
      )}
    </div>
  );
}
