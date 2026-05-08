import { useState } from "react";
import { monitorApi } from "../lib/monitor";
import type { LogsRangeResponse } from "../types/analysis";
import type { ContainerInfo } from "../types/monitor";

interface Props {
  /** Range efetivo: brushRange ?? presetRange. */
  range: { start: Date; end: Date };
  containers: ContainerInfo[];
  /** Container default (vem do chart focado quando entrou em análise). */
  defaultContainer: string | null;
  /**
   * Callback notificando logs fetched — pai usa pro useAnalysisContext.
   */
  onLogsFetched: (
    info: {
      range: { start: Date; end: Date };
      container: string;
      response: LogsRangeResponse;
    } | null,
  ) => void;
}

const MAX_RANGE_HOURS = 24;

export function AnalysisLogsPanel({
  range,
  containers,
  defaultContainer,
  onLogsFetched,
}: Props) {
  const [container, setContainer] = useState<string>(
    defaultContainer ?? containers[0]?.name ?? "",
  );
  const [response, setResponse] = useState<LogsRangeResponse | null>(null);
  const [fetchedRange, setFetchedRange] = useState<{ start: Date; end: Date } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rangeHours = (range.end.getTime() - range.start.getTime()) / 1000 / 3600;
  const rangeTooLarge = rangeHours > MAX_RANGE_HOURS;

  const handleFetch = async () => {
    if (!container) return;
    if (rangeTooLarge) {
      setError(`Range maior que ${MAX_RANGE_HOURS}h — refine antes de buscar`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await monitorApi.fetchLogsRange(
        container,
        range.start.toISOString(),
        range.end.toISOString(),
      );
      setResponse(r);
      setFetchedRange({ start: range.start, end: range.end });
      onLogsFetched({ range: { start: range.start, end: range.end }, container, response: r });
    } catch (e) {
      setError(String(e));
      setResponse(null);
      setFetchedRange(null);
      onLogsFetched(null);
    } finally {
      setLoading(false);
    }
  };

  // Quando o range mudou após um fetch, marca os logs como "atrasados"
  const stale =
    response !== null &&
    fetchedRange !== null &&
    (range.start.getTime() !== fetchedRange.start.getTime() ||
      range.end.getTime() !== fetchedRange.end.getTime());

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
        Logs do período
      </h3>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs"
          aria-label="Container"
        >
          {containers.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          onClick={handleFetch}
          disabled={loading || rangeTooLarge || !container}
          className="rounded-md bg-[var(--color-accent-primary)] px-3 py-1 text-xs font-semibold text-black transition hover:bg-[var(--color-accent-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Carregando…" : "Buscar logs do período"}
        </button>
        {rangeTooLarge && (
          <span className="text-[10px] text-[var(--color-danger)]">
            Range maior que {MAX_RANGE_HOURS}h
          </span>
        )}
        {stale && !loading && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            (logs do range anterior — clique pra atualizar)
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-2 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {response && (
        <>
          {response.truncated && (
            <div className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-2 text-[10px] text-[var(--color-warning)]">
              Logs truncados em {response.line_count} linhas — refine o range pra ver mais
            </div>
          )}
          <pre className="max-h-96 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-3 font-mono text-[10px] leading-relaxed text-[var(--color-text-primary)]">
            {response.text.length === 0 ? "(sem saída)" : response.text}
          </pre>
        </>
      )}
    </section>
  );
}
