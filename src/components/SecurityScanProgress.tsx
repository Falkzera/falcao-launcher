import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { InlineLoading } from "./Loading";

interface Props {
  scanning: boolean;
  onClose: () => void;
}

interface ProgressEvent {
  kind: "image" | "deps";
  line: string;
}

export function SecurityScanProgress({ scanning, onClose }: Props) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!scanning) {
      setLines([]);
      return;
    }

    const unlistenPromise = listen<ProgressEvent>("vuln-scan-progress", (event) => {
      setLines((prev) => [...prev.slice(-49), event.payload.line]);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [scanning]);

  return (
    <AnimatePresence>
      {scanning && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.95 }}
            className="w-[min(560px,90vw)] rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="page-title mb-3 text-lg text-[var(--color-text-primary)]">
              🔍 Scan em progresso
            </h3>
            <InlineLoading
              minHeight="3rem"
              messages={[
                "Buscando Dependabot alerts",
                "Trivy escaneando imagens Docker",
                "Cross-checking GHSA advisories",
                "Quase lá",
              ]}
            />
            {lines.length > 0 && (
              <pre className="mt-3 max-h-48 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-2 font-mono text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                {lines.join("\n")}
              </pre>
            )}
            <div className="mt-3 text-right">
              <button
                onClick={onClose}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                Fechar (continua em background)
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
