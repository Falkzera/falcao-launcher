import { useEffect } from "react";
import { monitorApi, usePolling } from "../lib/monitor";
import type { StackSummary } from "../types/monitor";
import { StackCard } from "./StackCard";

interface Props {
  enabled: boolean;
  /** Callback opcional pro pai saber quais containers já estão agrupados em stack
   *  (evita render duplicado no VmContainerGrid). */
  onStacksChange?: (stacks: StackSummary[]) => void;
}

export function StackGrid({ enabled, onStacksChange }: Props) {
  const { data: stacks, error } = usePolling(
    monitorApi.listStacks,
    30_000,
    enabled,
  );

  useEffect(() => {
    if (stacks && onStacksChange) {
      onStacksChange(stacks);
    }
  }, [stacks, onStacksChange]);

  if (error && !stacks) {
    return (
      <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
        Erro ao listar stacks: <span className="font-mono">{error}</span>
      </div>
    );
  }

  if (!stacks) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-48 animate-pulse rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)]"
          />
        ))}
      </div>
    );
  }

  if (stacks.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--color-border-default)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
        Nenhuma stack ativa — adicione{" "}
        <code className="font-mono text-[var(--color-text-primary)]">
          monitor.stack=&lt;nome&gt;
        </code>{" "}
        no docker-compose pra agrupar frontend Vercel + backend container.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {stacks.map((s) => (
        <StackCard key={s.name} summary={s} enabled={enabled} />
      ))}
    </div>
  );
}
