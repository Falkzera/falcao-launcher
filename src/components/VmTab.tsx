import { useTunnel } from "../lib/monitor";
import { VmHeader } from "./VmHeader";

export function VmTab() {
  const { ready, error } = useTunnel();

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]">
        Erro ao conectar na VM: {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <VmHeader enabled={ready} />
      <div className="text-sm text-[var(--color-text-secondary)]">
        (gráficos e cards de containers vêm nas próximas tarefas)
      </div>
    </div>
  );
}
