# Sprint 3 — Modo análise (gráficos expandidos com brush + sync + dashboard customizável)

**Data:** 2026-05-07
**Autor:** Falcão (supervisão) + Claude (escrita)
**Status:** rascunho — aguardando aprovação do Falcão

---

## Contexto

Sprints 1 e 2 entregaram observabilidade básica: aba VM com header de status, charts CPU/RAM/Disk/Network, health checks externos, e stacks agregando frontend Vercel + backend container. Funciona pra "olhar o estado atual", mas falha pra **investigação**: identificar quando algo aconteceu, correlacionar com logs, comparar métricas em paralelo.

Sprint 3 entrega o "modo análise": uma vista dedicada onde o usuário pode:

1. Expandir um gráfico clicado pra inspeção detalhada
2. Selecionar um período arbitrário via brush (clicar e arrastar)
3. Adicionar múltiplos charts num grid drag-drop pra comparação
4. Sincronizar o range temporal entre todos os charts (correlation)
5. Ver logs do container do período selecionado
6. Salvar e nomear layouts pra retomar análises recorrentes

**Princípio orientador:** ferramenta de **investigação** — entrar, explorar, sair. Não substitui a aba VM (que é "estado atual"). É uma **lente** sobre os mesmos dados.

**Visão de longo prazo:** o launcher vai ganhar versão webapp (PWA) pra acesso pelo celular. Layouts criados no desktop precisam funcionar visualmente em mobile, mesmo sem edição.

## Objetivos

1. Click num chart da aba VM abre a página de análise pré-populada com aquele chart
2. Page de análise tem grid drag-drop com layouts customizáveis (1 ou N charts)
3. Range temporal sincronizado entre todos os charts (single source of truth)
4. Brush selection refina o range visualmente sem refetch (subset dentro do preset)
5. Logs do período fetchados sob demanda (botão), por container selecionável
6. Layouts persistidos em localStorage com nomes, exportáveis e importáveis
7. Hook `useAnalysisContext` centraliza estado pra futura integração Claude
8. Mobile-friendly como viewer (sem drag-drop, charts empilhados)

## Não-objetivos (Sprint 3)

- Botão "Investigar com Claude" funcional — só preparação via hook (Sprint 4)
- Métricas custom via SQL ad-hoc — só métricas já coletadas pelo agente
- Auto-refresh em real-time durante análise — análise é sobre passado/seleção, não live tail
- Anotações no chart (marcadores de deploys, releases) — Sprint futura
- Comparação multi-projeto sobreposta no mesmo chart (sigof.cpu vs falcao.cpu na mesma linha) — workaround disponível: 2 charts no grid
- Drag-drop completo em mobile (`<600px`) — mobile é viewer, não editor
- Persistência server-side de layouts (multi-device sync) — só localStorage por enquanto; export/import resolve transporte manual
- Testes unitários frontend — alinhado com convenção atual do projeto (sem framework configurado)

## Decisões de design

### D1 — Surface UI: página dedicada acessada por click em chart

**Decisão:** click em qualquer `VmMetricChart` ou `VmContainerCard` da aba VM transiciona o conteúdo da aba pra `AnalysisPage`. Botão "← Voltar" volta pra dashboard. Estado de view local no `VmTab` (não nova aba no topbar).

**Por que não aba nova:** evita aba vazia esperando uso. Análise é uma **lente** sobre os dados da VM, não uma seção paralela. Mantém o storytelling INFRA → APLICAÇÕES intacto na aba VM regular.

**Por que não modal/drawer:** janela do desktop é 1200×800 nominal — modal centralizado fica claustrofóbico pra grid de 6 charts. Página dedicada usa toda a largura.

### D2 — Layout engine: drag-drop completo via `react-grid-layout`

**Decisão:** grid drag-drop com resize via `react-grid-layout`, biblioteca madura usada por Grafana/Metabase clones. Persistência via schema `{x, y, w, h, metric}` por chart.

**Por que não presets fixos (1/2/4):** Falcão pediu explicitamente flexibilidade — "plotar os gráficos na tela, lado a lado em quadros como em colunas e linhas". Investimento maior na primeira sprint vale.

**Adaptativo por breakpoint** (decisão complementar — necessária pra webapp futuro):
- Desktop ≥ 900px: drag-drop + resize, grid 12 colunas
- Tablet 600 – 900px: drag-drop com handles maiores, grid 6 colunas
- Mobile < 600px: stack vertical 1 chart por linha, sem drag (reorder via menu ↑/↓), brush desabilitado

Persistência guarda só layout `lg`; demais breakpoints são derivados via `<ResponsiveReactGridLayout>`.

### D3 — Sincronização: sempre automática

**Decisão:** range temporal e crosshair (hover) sincronizados em todos os charts. Single source of truth no `AnalysisState.brushRange` + `hoverTs`.

**Por que não toggle por chart:** caso de uso principal é **correlation** ("CPU subiu, o que aparece nos logs?"). Sync automático elimina cliques. Comparação cross-time (CPU agora vs RAM ontem) é caso raro — workaround: criar 2 layouts e abrir em janelas separadas (PWA permite).

### D4 — Brush é subset dentro do preset (mini-overview Grafana-style)

**Decisão:** preset (1h/6h/24h/7d/30d) define o range **carregado do DB**. Brush filtra **visualmente** dentro do range carregado, sem refetch. Recharts `<Brush>` nativo entrega isso (mini-overview na parte inferior do chart com handles arrastáveis).

**Por que não brush substituindo preset:** UX rica do mini-overview é melhor pra investigação. O usuário vê o range completo e foca num ponto. "Voltar ao todo" é só apagar a seleção — mais natural que escolher preset de novo.

**Custo extra:** ~1 dia (Recharts Brush é built-in, não precisa lib externa).

### D5 — Logs fetch manual + selectbox de container

**Decisão:** botão "Buscar logs do período" + `<select>` de container. Manual evita refetch enquanto o user arrasta o brush. Default: container do chart focado (se houver — caso contrário, primeiro container ativo).

**Backend Rust novo:** comando `monitor_fetch_logs_range(container, since, until)` faz `docker logs --since <iso> --until <iso> --tail 2000 <container>` via SSH. Limit 2000 linhas pelo Docker; se atingir, UI avisa "logs truncados — refine o range".

**Por que não auto-fetch:** brush é interativo (user arrasta) — fetch a cada movimento sobrecarregaria SSH e flickaria UI. Click explícito = controle.

### D6 — Layouts nomeados + export/import JSON

**Decisão:** layouts salvos por nome em `localStorage`, com export/import JSON pra portabilidade.

```typescript
type AnalysisLayout = {
  id: string;                  // uuid v4
  name: string;
  created_at: string;          // ISO
  updated_at: string;
  default_preset: WindowKey;
  charts: ChartSlot[];
};
```

Schema versionado (`SCHEMA_VERSION = 1`) pra migração futura. Bundle em `localStorage[analysis:layouts:v1]` contém `{ version, layouts, last_used_id }`.

Export/import: `Blob` JSON de 1 layout por vez, validação manual de schema (sem zod — sem dep nova).

**Por que não server-side sync:** complica auth/storage; export manual já cobre o caso de transportar análise entre máquinas. Server-side fica pra Sprint futura.

### D7 — Hook `useAnalysisContext` centraliza estado, sem UI Claude

**Decisão:** hook expõe `range + charts + logs + layout + preset` em formato serializável. Sprint 4 (Claude) consome este hook quando vier — sem refactor previsto.

**Por que não botão disabled "em breve":** parece bug em UX desktop polido. Quando Sprint 4 chegar, adiciona o botão; até lá, hook prontinho.

## Arquitetura

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Aba VM (existente, dashboard mode)                                         │
│   ├─ VmHeader / VM charts / Health Checks / Stacks / Containers            │
│   └─ Click em VmMetricChart ou VmContainerCard ──┐                          │
└──────────────────────────────────────────────────│──────────────────────────┘
                                                   │
                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  AnalysisPage (NEW — substitui o conteúdo da aba VM via state vmView)       │
│                                                                             │
│  [← Voltar]   Layout: <selectbox>   [+ Novo]   [Export ↗]   [Import ↙]     │
│  ─────────────────────────────────────────────────────────────────────────  │
│   PRESET: 1h 6h 24h 7d 30d  ·  Brush: 14:30 → 15:00 (30min) ✕              │
│  ─────────────────────────────────────────────────────────────────────────  │
│   <ResponsiveReactGridLayout>                                               │
│     ┌─ AnalysisChartSlot ─┐  ┌─ AnalysisChartSlot ─┐                       │
│     │ <MetricPicker>     │  │ <MetricPicker>      │                        │
│     │ [Recharts]         │  │ [Recharts]          │                        │
│     │ [Recharts <Brush>] │  │ [Recharts <Brush>]  │                        │
│     └────────────────────┘  └─────────────────────┘                        │
│   [+ Adicionar chart]                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│   <AnalysisLogsPanel>                                                       │
│     Container: <select>     [Buscar logs do período]                        │
│     <pre> ... </pre>                                                        │
│  ─────────────────────────────────────────────────────────────────────────  │
└─────────────────────────────────────────────────────────────────────────────┘

State global no AnalysisPage:
  preset: WindowKey
  brushRange: { start, end } | null   ← single source of truth p/ charts + logs
  charts: ChartSlot[]
  logsContainer: string | null
  lastFetchedLogs: { range, container, text, truncated } | null
  hoverTs: number | null              ← crosshair sincronizado

Persistência (localStorage):
  analysis:layouts:v1 = { version: 1, layouts: [...], last_used_id }
```

## Componentes (frontend)

### `src/components/AnalysisPage.tsx` (orquestrador)
~250 linhas. Renderiza header + grid + logs panel. Orquestra estado de range, brush, layouts, logs. Expõe `useAnalysisContext()` consumível (sem UI Claude por enquanto, pronto pra Sprint 4).

### `src/components/AnalysisGrid.tsx`
Wrapper de `<ResponsiveReactGridLayout>`. Recebe `charts: ChartSlot[]` e callbacks `onLayoutChange`, `onSlotMetricChange`, `onAddSlot`, `onRemoveSlot`. Breakpoints internos.

### `src/components/AnalysisChartSlot.tsx`
Slot individual do grid. Renderiza:
- Header com `<MetricPicker>` + `[×]` botão remover
- Recharts chart (linha) com `<Brush>` na parte inferior
- Crosshair sincronizado via `hoverTs` (vem do context)
- Erro/loading/empty state localizado (não derruba o grid)

Usa `useMetricSeries({ metric, windowMinutes, bucket })` interno pra fetchar quando preset/metric muda. Brush local emite evento global via callback.

### `src/components/AnalysisLogsPanel.tsx`
- `<select>` de container (default: container focado)
- Botão "Buscar logs do período"
- `<pre>` com logs + indicador de truncamento se hit limite

### `src/components/AnalysisLayoutPicker.tsx`
Header com:
- `<select>` de layouts salvos (current = ativo)
- Botões `+ Novo`, `Salvar como`, `Renomear`, `Excluir`, `Export ↗`, `Import ↙`
- Em mobile (<600px): vira menu hambúrguer `⋯`

### `src/components/MetricPicker.tsx`
`<select>` que lista todas as métricas disponíveis. Agrupado por source:
- VM: load_1m, mem_pct, mem_used_bytes, cpu_pct, disk_used_bytes, net_tx_bytes, net_rx_bytes
- Hetzner: outgoing_traffic_bytes, ingoing_traffic_bytes, cost_accumulated_usd
- Container `<nome>`: cpu_pct, mem_pct, mem_used_bytes (1 entrada por container ativo)

Lista derivada: query `monitor_list_containers` + lista hardcoded de métricas VM/Hetzner.

### Hooks novos

`src/lib/useAnalysisContext.ts`:
```typescript
export function useAnalysisContext(): AnalysisContext
```
Wrapper sobre o state do AnalysisPage. Expõe contexto serializável pra futuro consumer (Claude).

`src/lib/useAnalysisLayouts.ts`:
```typescript
export function useAnalysisLayouts(): {
  layouts: AnalysisLayout[];
  currentLayout: AnalysisLayout | null;
  save(name: string, snapshot: LayoutSnapshot): void;
  update(id: string, patch: Partial<AnalysisLayout>): void;
  delete(id: string): void;
  setCurrent(id: string | null): void;
  duplicate(id: string): void;
  exportLayout(id: string): void;
  importLayout(file: File): Promise<AnalysisLayout>;
}
```
Persistência localStorage `analysis:layouts:v1`. Validação de schema na leitura (handler de versão futura/corrompido).

## Modelo de dados

```typescript
const SCHEMA_VERSION = 1;

type WindowKey = "1h" | "6h" | "24h" | "7d" | "30d";

type MetricRef =
  | { kind: "vm"; metric: string }
  | { kind: "container"; resource: string; metric: string }
  | { kind: "hetzner"; metric: string };

type ChartSlot = {
  id: string;             // uuid v4
  x: number; y: number;   // posição grid (lg breakpoint)
  w: number; h: number;   // tamanho grid
  metric: MetricRef;
};

type AnalysisLayout = {
  id: string;
  name: string;
  created_at: string;     // ISO
  updated_at: string;
  default_preset: WindowKey;
  charts: ChartSlot[];
};

type LayoutsBundle = {
  version: 1;
  layouts: AnalysisLayout[];
  last_used_id: string | null;
};

type AnalysisContext = {
  range: { start: Date; end: Date };       // brushRange ?? presetRange
  preset: WindowKey;
  charts: Array<{
    metric: MetricRef;
    bucket: MetricBucket;
    series: MetricPoint[];
  }>;
  logs: {
    container: string | null;
    fetched_for: { start: Date; end: Date } | null;
    text: string | null;
    truncated: boolean;
  };
  layout: { id: string | null; name: string | null };
};
```

## Backend Rust

### Comando novo: `monitor_fetch_logs_range`

```rust
#[tauri::command]
pub async fn monitor_fetch_logs_range(
    container: String,
    since: String,    // ISO 8601 UTC
    until: String,
    state: State<'_, MonitorState>,
) -> Result<LogsRangeResponse, String>

pub struct LogsRangeResponse {
    pub text: String,
    pub truncated: bool,    // true se hit 2000-line tail
    pub line_count: usize,
}
```

Implementação:
- Validar `container` via regex existente (anti-injection)
- Parse `since` e `until` como `DateTime<Utc>`
- Validar range: `until - since <= 24h` (anti-timeout SSH); senão erro estruturado
- SSH command: `docker logs --since <iso> --until <iso> --tail 2000 <container>` via `ssh -t falcao@<vm>`
- Captura stdout, conta linhas, retorna

Tests:
- `parses_iso_timestamps_to_utc`
- `rejects_range_over_24h`
- `rejects_invalid_container_name` (reusa regex existente)

## Edge cases e error handling

| Cenário | Comportamento |
|---|---|
| Tunnel SSH cai durante análise | Toast "conexão perdida"; charts viram skeletons; botão "Reconectar" |
| Métrica retorna 0 pontos | Slot mostra "sem dados nesse período"; resto do grid funciona |
| Backend Rust 500 em metric_series | Slot mostra erro local; botão "tentar de novo"; resto do grid OK |
| `monitor_fetch_logs_range` timeout SSH | Mensagem "logs demorando — range muito grande?"; botão "tentar com range menor" |
| Range > 24h ao buscar logs | Bloqueia no front com toast antes de invocar; desabilita botão |
| `localStorage.QuotaExceededError` ao salvar layout | Toast com instrução; UI de gestão (deletar antigos) acessível pelo selectbox de layouts |
| JSON importado inválido | Toast "layout inválido: <razão>"; sem mudança no estado |
| Schema version desconhecida (futuro > atual) | Toast "atualize o launcher pra abrir esses layouts"; ignora bundle, usa default |
| Layout corrompido em localStorage | Auto-fallback `createDefaultBundle()`; preserva layouts válidos do array; toast informa quantos descartados |
| Chart referencia container que não existe mais (renomeado/removido) | Slot renderiza erro "métrica indisponível" + botão "trocar métrica" — mantém posição no grid |

## Testing

**Rust (`cargo test`):**
- 3 testes em `monitor_fetch_logs_range`: parse timestamps, validação range, container regex
- Sem teste de integração SSH real (mantém padrão `#[ignore]` igual `db::tests::insert_and_read_back`)

**Frontend:**
- `pnpm exec tsc --noEmit` valida tipos do schema, `MetricRef` discriminated union, hook signatures
- Sem testes unitários TS (alinhado com convenção atual do projeto)
- Smoke manual via dev server cobrindo 5 fluxos:
  1. Click em chart na VM → entra na análise pré-populada
  2. Brush em chart 1 → todos os charts mostram highlight no mesmo range
  3. Adicionar 2 charts no grid + arrastar pra reorganizar
  4. Salvar layout, recarregar app, layout ainda lá
  5. Export → import noutra "instalação" (ou mesmo browser com localStorage limpo)

## Critérios de aceite

A sprint só fecha se:

1. ✅ Click em qualquer `VmMetricChart` ou `VmContainerCard` da aba VM transiciona pra `AnalysisPage` com aquele chart pré-populado
2. ✅ Botão "← Voltar" volta pra dashboard sem perder estado da análise (nova entrada começa do zero)
3. ✅ Grid drag-drop funciona em desktop: arrastar e redimensionar charts atualiza posição persistida
4. ✅ Mobile (<600px) renderiza charts empilhados sem horizontal scroll, sem drag-drop, com reorder por menu
5. ✅ Brush em qualquer chart sincroniza visualmente em todos os outros (highlight do range)
6. ✅ Hover em qualquer chart sincroniza crosshair em todos
7. ✅ Logs fetched manualmente via botão pelo container do `<select>` no range atual (preset ou brush)
8. ✅ Range > 24h pra logs é bloqueado com mensagem clara
9. ✅ "Salvar layout como" persiste nome + estado em localStorage
10. ✅ Export gera JSON downloadável; import lê e adiciona à lista
11. ✅ Schema corrompido / versão futura é tratado com toast + fallback (não trava UI)
12. ✅ `useAnalysisContext` retorna estado serializável pronto pra Sprint 4 (Claude)
13. ✅ Build release passa sem warnings novos
14. ✅ `cargo test` passa (incluindo 3 novos do `monitor_fetch_logs_range`)
15. ✅ Documentação atualizada: agent.md das pastas tocadas + CLAUDE.md + skill `falcao-launcher`

## Riscos

1. **`react-grid-layout` ainda usa React 18 types** — verificar compat com React 19. Caso falhe, considerar `@dnd-kit` + grid manual (mais código mas controle total).
2. **Recharts `<Brush>` em mobile** — touch events podem ter glitch. Se impossível desabilitar de forma limpa por breakpoint, fallback é `pointer-events: none` no brush em viewport <600px.
3. **localStorage quota** — em uso intenso (50+ layouts cada com 10 charts), pode estourar. Bundle JSON estimado: ~5KB por layout. Quota típica: 5MB. Limite efetivo ~1000 layouts. Aceitável.
4. **Performance com 6+ charts simultâneos** — Recharts re-renderiza tudo a cada mudança de `hoverTs`. Memoização agressiva via `React.memo` + comparação rasa. Se ainda lag, fallback: throttle hover sync a 50ms.
5. **Mobile compatibility incompleta** — meta é "viewer", não "editor". Brush desabilitado pode frustrar quem espera funcionalidade plena. Comunicar claramente em UI ("modo de visualização — edite no desktop").

## Deps novas

- `react-grid-layout@^1.5` (drag-drop grid responsivo) — ~~150KB minified, MIT, mantida ativamente
- Sem outras deps (Recharts já no projeto, `uuid` já usado, framer-motion já no projeto)

## Próximos passos pós-aprovação

→ Plan TDD em `docs/superpowers/plans/2026-05-07-modo-analise.md` quebrando essas decisões em fases (provavelmente A: backend Rust + types, B: hooks de state e layouts, C: componentes core, D: drag-drop e responsividade, E: docs + PR).
