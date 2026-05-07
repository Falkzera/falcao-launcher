import { useMemo } from "react";
import { monitorApi, usePolling } from "../lib/monitor";
import { VmContainerCard } from "./VmContainerCard";

interface Props {
  enabled: boolean;
  onSelect: (containerName: string) => void;
  /** Nomes de containers que já estão sendo mostrados em StackCards
   *  (não devem aparecer crus na grid pra evitar duplicação). */
  excludeNames?: string[];
}

export function VmContainerGrid({ enabled, onSelect, excludeNames }: Props) {
  const { data: containers, error } = usePolling(
    monitorApi.listContainers,
    15_000,
    enabled,
  );

  const excludeSet = useMemo(
    () => new Set(excludeNames ?? []),
    [excludeNames],
  );

  const orphans = useMemo(
    () =>
      containers
        ? containers.filter((c) => !excludeSet.has(c.name))
        : null,
    [containers, excludeSet],
  );

  if (error && !containers) {
    return (
      <div className="text-sm text-[var(--color-danger)]">
        Erro ao listar containers: {error}
      </div>
    );
  }
  if (!orphans) {
    return (
      <div className="text-sm text-[var(--color-text-secondary)]">
        Carregando containers…
      </div>
    );
  }
  if (orphans.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--color-border-default)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
        {excludeSet.size > 0
          ? "Nenhum container fora de stacks."
          : "Nenhum container ativo nos últimos 5 min."}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {orphans.map((c) => (
        <VmContainerCard
          key={c.name}
          container={c}
          onClick={() => onSelect(c.name)}
        />
      ))}
    </div>
  );
}
