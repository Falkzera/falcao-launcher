import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { monitorApi, usePolling } from "../lib/monitor";
import type { StackSummary } from "../types/monitor";
import { InlineLoading } from "./Loading";
import { StackCard } from "./StackCard";
import { StackDrawer } from "./StackDrawer";

interface Props {
  enabled: boolean;
  /** Callback opcional pro pai saber quais containers já estão agrupados em stack
   *  (evita render duplicado no VmContainerGrid). Sempre recebe TODAS as stacks
   *  vivas, independente do filtro visual `showFrontendOnly`. */
  onStacksChange?: (stacks: StackSummary[]) => void;
  /** Se false (default), esconde stacks só-frontend (sem container na VM). */
  showFrontendOnly?: boolean;
  /** Repassado pro StackDrawer — botão "🔍 Investigar período" por container. */
  onInvestigateContainer?: (containerName: string) => void;
}

export function StackGrid({
  enabled,
  onStacksChange,
  showFrontendOnly = false,
  onInvestigateContainer,
}: Props) {
  const { data: stacks, error } = usePolling(
    monitorApi.listStacks,
    30_000,
    enabled,
  );

  const [selectedStack, setSelectedStack] = useState<string | null>(null);

  useEffect(() => {
    if (stacks && onStacksChange) {
      onStacksChange(stacks);
    }
  }, [stacks, onStacksChange]);

  // Se a stack selecionada sumir do polling, fecha o drawer
  useEffect(() => {
    if (selectedStack && stacks && !stacks.some((s) => s.name === selectedStack)) {
      setSelectedStack(null);
    }
  }, [selectedStack, stacks]);

  // Esc fecha drawer
  useEffect(() => {
    if (!selectedStack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedStack(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedStack]);

  // Body scroll lock enquanto drawer está aberto — evita scroll-chaining
  // (scroll na drawer não rola a página atrás).
  useEffect(() => {
    if (!selectedStack) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [selectedStack]);

  if (error && !stacks) {
    return (
      <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
        Erro ao listar stacks: <span className="font-mono">{error}</span>
      </div>
    );
  }

  if (!stacks) {
    return (
      <InlineLoading
        minHeight="12rem"
        messages={[
          "Buscando stacks ativas",
          "Sincronizando com a VM",
          "Lendo labels dos containers",
          "Quase lá",
        ]}
      />
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

  // Filtra stacks só-frontend (sem container conhecido) quando o toggle
  // está desligado. O callback onStacksChange recebe a lista completa pra
  // que VmContainerGrid continue suprimindo containers já agrupados.
  const visible = showFrontendOnly
    ? stacks
    : stacks.filter((s) => s.container_names.length > 0);

  if (visible.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--color-border-default)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
        Nenhuma stack com backend na VM. Habilite{" "}
        <span className="font-mono text-[var(--color-text-primary)]">
          Mostrar stacks só-frontend
        </span>{" "}
        nas preferências pra incluir os {stacks.length} projeto
        {stacks.length === 1 ? "" : "s"} Vercel sem container.
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {visible.map((s) => (
          <StackCard
            key={s.name}
            summary={s}
            enabled={enabled}
            onOpen={setSelectedStack}
          />
        ))}
      </div>
      <AnimatePresence>
        {selectedStack && (
          <StackDrawer
            key={selectedStack}
            stackName={selectedStack}
            enabled={enabled}
            onClose={() => setSelectedStack(null)}
            onInvestigateContainer={
              onInvestigateContainer
                ? (name) => {
                    setSelectedStack(null); // fecha drawer ao entrar em análise
                    onInvestigateContainer(name);
                  }
                : undefined
            }
          />
        )}
      </AnimatePresence>
    </>
  );
}
