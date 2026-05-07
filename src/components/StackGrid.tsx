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
   *  (evita render duplicado no VmContainerGrid). */
  onStacksChange?: (stacks: StackSummary[]) => void;
}

export function StackGrid({ enabled, onStacksChange }: Props) {
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

  return (
    <>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {stacks.map((s) => (
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
          />
        )}
      </AnimatePresence>
    </>
  );
}
