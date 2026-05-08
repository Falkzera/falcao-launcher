import type { MetricRef } from "../types/analysis";
import type { ContainerInfo } from "../types/monitor";

interface Props {
  value: MetricRef;
  onChange: (ref: MetricRef) => void;
  /** Containers ativos pra popular o group `Container` do select. */
  containers: ContainerInfo[];
}

/**
 * Lista hardcoded de métricas VM/Hetzner. Pra container, derivamos da prop
 * `containers` em runtime.
 *
 * Mantém em sync com schema das tabelas — ver monitor-shared/src/lib.rs e
 * coletores em monitor-agent/src/collectors/.
 */
const VM_METRICS = [
  { metric: "cpu_pct", label: "CPU %" },
  { metric: "load_1m", label: "Load 1m" },
  { metric: "mem_pct", label: "RAM %" },
  { metric: "mem_used_bytes", label: "RAM usada (bytes)" },
  { metric: "disk_used_bytes", label: "Disco usado (bytes)" },
  { metric: "net_tx_bytes", label: "Network out (bytes)" },
  { metric: "net_rx_bytes", label: "Network in (bytes)" },
];

const HETZNER_METRICS = [
  { metric: "outgoing_traffic_bytes", label: "Tráfego saída (Hetzner)" },
  { metric: "ingoing_traffic_bytes", label: "Tráfego entrada (Hetzner)" },
  { metric: "cost_accumulated_usd", label: "Custo acumulado (USD)" },
];

const CONTAINER_METRICS = [
  { metric: "cpu_pct", label: "CPU %" },
  { metric: "mem_pct", label: "RAM %" },
  { metric: "mem_used_bytes", label: "RAM usada (bytes)" },
];

function refToValue(ref: MetricRef): string {
  if (ref.kind === "container") return `container:${ref.resource}:${ref.metric}`;
  return `${ref.kind}:${ref.metric}`;
}

function valueToRef(value: string): MetricRef | null {
  const parts = value.split(":");
  if (parts[0] === "vm" && parts.length === 2) {
    return { kind: "vm", metric: parts[1] };
  }
  if (parts[0] === "hetzner" && parts.length === 2) {
    return { kind: "hetzner", metric: parts[1] };
  }
  if (parts[0] === "container" && parts.length === 3) {
    return { kind: "container", resource: parts[1], metric: parts[2] };
  }
  return null;
}

export function MetricPicker({ value, onChange, containers }: Props) {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const ref = valueToRef(e.target.value);
    if (ref) onChange(ref);
  };

  return (
    <select
      value={refToValue(value)}
      onChange={handleChange}
      className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent-primary)]/60 focus:outline-none"
      aria-label="Selecionar métrica"
    >
      <optgroup label="VM">
        {VM_METRICS.map((m) => (
          <option key={`vm:${m.metric}`} value={`vm:${m.metric}`}>
            VM · {m.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Hetzner">
        {HETZNER_METRICS.map((m) => (
          <option key={`hetzner:${m.metric}`} value={`hetzner:${m.metric}`}>
            Hetzner · {m.label}
          </option>
        ))}
      </optgroup>
      {containers.length > 0 && (
        <optgroup label="Containers">
          {containers.flatMap((c) =>
            CONTAINER_METRICS.map((m) => (
              <option
                key={`container:${c.name}:${m.metric}`}
                value={`container:${c.name}:${m.metric}`}
              >
                {c.name} · {m.label}
              </option>
            )),
          )}
        </optgroup>
      )}
    </select>
  );
}
