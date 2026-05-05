// src/components/Tabs.tsx
import { motion } from "framer-motion";
import clsx from "clsx";

export type Tab = {
  key: string;
  label: string;
};

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (key: string) => void;
};

export function Tabs({ tabs, active, onChange }: Props) {
  return (
    <div className="relative flex gap-1 border-b border-[var(--color-border-subtle)] px-3">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={clsx(
              "relative px-3 py-2 text-xs font-semibold transition",
              isActive
                ? "text-[var(--color-text-primary)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
            )}
          >
            {tab.label}
            {isActive && (
              <motion.div
                layoutId="tabs-underline"
                className="absolute bottom-[-1px] left-2 right-2 h-[2px] bg-[var(--color-accent-primary)]"
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
