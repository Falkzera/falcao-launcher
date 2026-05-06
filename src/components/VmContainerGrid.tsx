import { monitorApi, usePolling } from "../lib/monitor";
import { VmContainerCard } from "./VmContainerCard";

interface Props {
  enabled: boolean;
  onSelect: (containerName: string) => void;
}

export function VmContainerGrid({ enabled, onSelect }: Props) {
  const { data: containers, error } = usePolling(
    monitorApi.listContainers,
    15_000,
    enabled,
  );

  if (error && !containers) {
    return (
      <div className="text-sm text-[var(--color-danger)]">
        Erro ao listar containers: {error}
      </div>
    );
  }
  if (!containers) {
    return (
      <div className="text-sm text-[var(--color-text-secondary)]">
        Carregando containers…
      </div>
    );
  }
  if (containers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--color-border-default)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
        Nenhum container ativo nos últimos 5 min.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {containers.map((c) => (
        <VmContainerCard
          key={c.name}
          container={c}
          onClick={() => onSelect(c.name)}
        />
      ))}
    </div>
  );
}
