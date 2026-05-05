import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Checkbox } from "./Checkbox";

export type Toggle = {
  key: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
};

export type ToggleGroup = {
  title: string;
  toggles: Toggle[];
};

type Props = {
  groups: ToggleGroup[];
};

export function SettingsMenu({ groups }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="preferências"
        aria-label="preferências"
        aria-expanded={open}
        className={
          open
            ? "rounded-md border border-[var(--color-accent-primary)]/60 bg-[var(--color-bg-secondary)] p-2 text-[var(--color-accent-primary)] transition"
            : "rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-2 text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
        }
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 20v-6M6 8V4M6 20v-8M18 16V4M18 20v-2M2 8h8M16 16h6M14 12h8" />
          <circle cx="6" cy="14" r="2" />
          <circle cx="12" cy="8" r="2" />
          <circle cx="18" cy="16" r="2" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
            className="absolute right-0 top-full z-50 mt-2 w-72 origin-top-right overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur-md"
            role="menu"
          >
            <div className="border-b border-[var(--color-border-subtle)] px-4 py-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
                preferências
              </div>
            </div>
            <div className="flex flex-col">
              {groups.map((group, groupIdx) => (
                <div
                  key={group.title}
                  className={
                    groupIdx > 0
                      ? "border-t border-[var(--color-border-subtle)] py-2"
                      : "py-2"
                  }
                >
                  <div className="px-4 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]/80">
                    {group.title}
                  </div>
                  {group.toggles.map((t) => (
                    <label
                      key={t.key}
                      className="group flex cursor-pointer items-start gap-3 px-4 py-2 transition hover:bg-[var(--color-bg-tertiary)]/40"
                    >
                      <div className="mt-[1px] shrink-0">
                        <Checkbox
                          variant="minimal"
                          checked={t.checked}
                          onChange={t.onChange}
                          label=""
                          className="!gap-0"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs leading-tight text-[var(--color-text-primary)]">
                          {t.label}
                        </div>
                        {t.hint && (
                          <div className="mt-0.5 text-[10px] leading-snug text-[var(--color-text-muted)]">
                            {t.hint}
                          </div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
