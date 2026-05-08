import { useCallback, useEffect, useState } from "react";
import {
  ANALYSIS_SCHEMA_VERSION,
  LAYOUTS_STORAGE_KEY,
  type AnalysisLayout,
  type ChartSlot,
  type LayoutsBundle,
  createDefaultBundle,
} from "../types/analysis";
import type { WindowKey } from "../types/monitor";

/**
 * Snapshot do estado atual do AnalysisPage que vira um layout salvo.
 * Não é o layout completo (sem id/name/timestamps) — o hook completa.
 */
export interface LayoutSnapshot {
  default_preset: WindowKey;
  charts: ChartSlot[];
}

interface UseAnalysisLayoutsReturn {
  layouts: AnalysisLayout[];
  currentLayout: AnalysisLayout | null;
  /** Salva snapshot atual com nome novo. Retorna o id criado. */
  save(name: string, snapshot: LayoutSnapshot): string;
  /** Patch parcial de campos do layout. Bumps updated_at. */
  update(id: string, patch: Partial<AnalysisLayout>): void;
  /** Remove. Se era o currentLayout, limpa current. */
  delete(id: string): void;
  /** Marca um layout como atual (persiste em last_used_id). */
  setCurrent(id: string | null): void;
  /** Duplica com nome "<name> (cópia)". Retorna id da cópia. */
  duplicate(id: string): string | null;
  /** Triga download JSON de 1 layout. */
  exportLayout(id: string): void;
  /** Lê JSON de um File, valida, adiciona à lista. Retorna o layout adicionado. */
  importLayout(file: File): Promise<AnalysisLayout>;
  /** Mensagem de erro de I/O ou parse (ex: localStorage cheio). */
  error: string | null;
}

/**
 * Lê bundle do localStorage com tolerância a falhas:
 *   - chave ausente → bundle default
 *   - JSON corrompido → bundle default + console.warn
 *   - versão futura (> known) → bundle default + erro user-facing
 *   - layouts individuais corrompidos → ignora os corrompidos, mantém bons
 */
function readBundleFromStorage(): { bundle: LayoutsBundle; warning: string | null } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LAYOUTS_STORAGE_KEY);
  } catch {
    return { bundle: createDefaultBundle(), warning: "localStorage indisponível" };
  }
  if (!raw) return { bundle: createDefaultBundle(), warning: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[useAnalysisLayouts] bundle corrompido, recriando");
    return {
      bundle: createDefaultBundle(),
      warning: "bundle de layouts estava corrompido — recriado vazio",
    };
  }

  const obj = parsed as Partial<LayoutsBundle>;
  if (typeof obj.version !== "number") {
    return { bundle: createDefaultBundle(), warning: "bundle sem version — recriado" };
  }
  if (obj.version > ANALYSIS_SCHEMA_VERSION) {
    return {
      bundle: createDefaultBundle(),
      warning: `layouts foram salvos por versão ${obj.version} (atual: ${ANALYSIS_SCHEMA_VERSION}) — atualize o launcher`,
    };
  }

  const layouts = Array.isArray(obj.layouts) ? obj.layouts : [];
  const valid: AnalysisLayout[] = [];
  let droppedCount = 0;
  for (const l of layouts) {
    if (isValidLayout(l)) valid.push(l);
    else droppedCount++;
  }
  const last_used_id = typeof obj.last_used_id === "string" ? obj.last_used_id : null;

  return {
    bundle: { version: ANALYSIS_SCHEMA_VERSION, layouts: valid, last_used_id },
    warning: droppedCount > 0
      ? `${droppedCount} layout${droppedCount === 1 ? "" : "s"} corrompido${droppedCount === 1 ? "" : "s"} foi descartado`
      : null,
  };
}

/** Type-guard que confirma shape mínimo válido. Lenient: aceita extras. */
function isValidLayout(x: unknown): x is AnalysisLayout {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.created_at === "string" &&
    typeof o.updated_at === "string" &&
    typeof o.default_preset === "string" &&
    Array.isArray(o.charts)
  );
}

function writeBundleToStorage(bundle: LayoutsBundle): { ok: true } | { ok: false; error: string } {
  try {
    localStorage.setItem(LAYOUTS_STORAGE_KEY, JSON.stringify(bundle));
    return { ok: true };
  } catch (e) {
    if (e instanceof Error && e.name === "QuotaExceededError") {
      return { ok: false, error: "localStorage cheio — delete layouts antigos" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "erro desconhecido" };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function useAnalysisLayouts(): UseAnalysisLayoutsReturn {
  const [bundle, setBundle] = useState<LayoutsBundle>(() => readBundleFromStorage().bundle);
  const [error, setError] = useState<string | null>(() => readBundleFromStorage().warning);

  useEffect(() => {
    const result = writeBundleToStorage(bundle);
    if (!result.ok) setError(result.error);
  }, [bundle]);

  const currentLayout =
    bundle.layouts.find((l) => l.id === bundle.last_used_id) ?? null;

  const save = useCallback((name: string, snapshot: LayoutSnapshot): string => {
    const layout: AnalysisLayout = {
      id: crypto.randomUUID(),
      name,
      created_at: nowIso(),
      updated_at: nowIso(),
      default_preset: snapshot.default_preset,
      charts: snapshot.charts,
    };
    setBundle((prev) => ({
      ...prev,
      layouts: [...prev.layouts, layout],
      last_used_id: layout.id,
    }));
    setError(null);
    return layout.id;
  }, []);

  const update = useCallback((id: string, patch: Partial<AnalysisLayout>) => {
    setBundle((prev) => ({
      ...prev,
      layouts: prev.layouts.map((l) =>
        l.id === id ? { ...l, ...patch, id: l.id, updated_at: nowIso() } : l,
      ),
    }));
    setError(null);
  }, []);

  const remove = useCallback((id: string) => {
    setBundle((prev) => ({
      ...prev,
      layouts: prev.layouts.filter((l) => l.id !== id),
      last_used_id: prev.last_used_id === id ? null : prev.last_used_id,
    }));
    setError(null);
  }, []);

  const setCurrent = useCallback((id: string | null) => {
    setBundle((prev) => ({ ...prev, last_used_id: id }));
  }, []);

  const duplicate = useCallback((id: string): string | null => {
    const orig = bundle.layouts.find((l) => l.id === id);
    if (!orig) return null;
    const copy: AnalysisLayout = {
      ...orig,
      id: crypto.randomUUID(),
      name: `${orig.name} (cópia)`,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    setBundle((prev) => ({
      ...prev,
      layouts: [...prev.layouts, copy],
      last_used_id: copy.id,
    }));
    return copy.id;
  }, [bundle.layouts]);

  const exportLayout = useCallback((id: string) => {
    const layout = bundle.layouts.find((l) => l.id === id);
    if (!layout) return;
    const exportData = { version: ANALYSIS_SCHEMA_VERSION, layout };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${layout.name.replace(/[^a-z0-9-_]/gi, "_")}-${layout.id.slice(0, 8)}.layout.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [bundle.layouts]);

  const importLayout = useCallback(async (file: File): Promise<AnalysisLayout> => {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSON inválido");
    }
    const obj = parsed as { version?: number; layout?: unknown };
    if (typeof obj.version !== "number") {
      throw new Error("arquivo sem version");
    }
    if (obj.version > ANALYSIS_SCHEMA_VERSION) {
      throw new Error(`versão ${obj.version} não suportada (atual: ${ANALYSIS_SCHEMA_VERSION})`);
    }
    if (!isValidLayout(obj.layout)) {
      throw new Error("layout inválido (campos obrigatórios faltando)");
    }
    const imported: AnalysisLayout = {
      ...obj.layout,
      id: crypto.randomUUID(),
      name: obj.layout.name + " (importado)",
      updated_at: nowIso(),
    };
    setBundle((prev) => ({
      ...prev,
      layouts: [...prev.layouts, imported],
      last_used_id: imported.id,
    }));
    setError(null);
    return imported;
  }, []);

  return {
    layouts: bundle.layouts,
    currentLayout,
    save,
    update,
    delete: remove,
    setCurrent,
    duplicate,
    exportLayout,
    importLayout,
    error,
  };
}
