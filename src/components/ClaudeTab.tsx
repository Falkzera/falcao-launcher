// src/components/ClaudeTab.tsx
import { useState } from "react";
import clsx from "clsx";
import type { ClaudeProjectState, Granularity } from "../types";
import { costUsd, formatCost, humanizeTokens, totalTokens } from "../lib/claudeCost";
import { SessionsList } from "./SessionsList";
import { TokensChart } from "./TokensChart";

type Props = {
  state: ClaudeProjectState | null;
  projectPath: string;
};

const GRANULARITIES: Array<{ key: Granularity; label: string }> = [
  { key: "day", label: "Dia" },
  { key: "month", label: "Mês" },
  { key: "year", label: "Ano" },
];

export function ClaudeTab({ state, projectPath }: Props) {
  const [granularity, setGranularity] = useState<Granularity>("day");

  if (!state || state.sessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-[var(--color-text-muted)]">
        nenhuma sessão Claude registrada neste projeto.
        <br />
        clique no botão de spawn pra começar uma.
      </div>
    );
  }

  const totalT = totalTokens(state.total_usage);
  const dominantModel = state.sessions[0]?.model ?? null;
  const totalCost = state.sessions.reduce(
    (acc: number, s: ClaudeProjectState["sessions"][number]) => acc + costUsd(s.usage, s.model),
    0,
  );

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="px-4 py-3">
        <div className="font-mono text-[11px] text-[var(--color-text-secondary)]">
          {state.sessions.length} {state.sessions.length === 1 ? "sessão" : "sessões"}
          {" · "}
          {humanizeTokens(totalT)} tokens
          {totalCost >= 0.01 && (
            <>
              {" · "}
              <span className="text-[var(--color-text-muted)]">≡</span> {formatCost(totalCost)}
            </>
          )}
        </div>
      </div>

      <div className="px-4 pb-2">
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
          {GRANULARITIES.map((g) => (
            <button
              key={g.key}
              onClick={() => setGranularity(g.key)}
              className={clsx(
                "px-3 py-1 text-[11px] font-semibold transition",
                granularity === g.key
                  ? "bg-[var(--color-claude-primary)] text-white"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-4">
        <TokensChart
          projectPath={projectPath}
          model={dominantModel}
          granularity={granularity}
        />
      </div>

      <div className="border-t border-[var(--color-border-subtle)] px-4 py-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          sessões
        </div>
        <SessionsList sessions={state.sessions} activeSessionId={state.active_session_id} />
      </div>
    </div>
  );
}
