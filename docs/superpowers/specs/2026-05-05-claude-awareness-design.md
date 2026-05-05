# Claude Code Awareness — Design Spec

**Data:** 2026-05-05
**Status:** aprovado pelo Falcão, pronto pra plano de implementação
**Sub-projeto:** D (de um conjunto B + A + D combinados, fase 1 do roadmap "dashboard direction")

---

## 1. Escopo

O launcher passa a enxergar, integrar e dialogar com **sessões do Claude Code** que vivem em `~/.claude/projects/`. Vira um cockpit unificado de "qual projeto eu (Falcão) tô codando + qual projeto a IA (Claude) tá codando comigo".

### Inclui (v1 = "Core")

1. **Chip "Claude" no card** — estado: ativo (sessão nos últimos 5min) / histórico / cost-equiv ≥ threshold.
2. **Lista de sessões por projeto** — tab "Claude" no drawer atual (renomeado conceitualmente pra "Project Detail").
3. **Botão "Spawn Claude here"** — 5º ícone na linha de actions do card (ao lado de VSCode/Ghostty/Files).
4. **Token-equivalent cost** — totalizado por sessão e por projeto, exibido em formato "≡ $X.XX" com tooltip honesto ("você não foi cobrado por isso").
5. **Worktree → sessão** — cai naturalmente do match por path canônico; nenhuma lógica especial.

### Não inclui (defer pra v2 = "Full")

6. **Diff por sessão** — opt-in atrás de botão. Exige parsear `file-history-snapshot` events e agregar mudanças. Implementação não-trivial; deferida pra validar Core primeiro.

---

## 2. Data Layer (Rust)

### 2.1 Módulo novo

`src-tauri/src/claude.rs`

### 2.2 Tipos centrais

```rust
pub struct ClaudeSession {
    pub session_id: String,           // do nome do arquivo (UUID)
    pub project_path: String,         // path canônico do `cwd` em JSONL
    pub git_branch: Option<String>,   // de `gitBranch`
    pub title: Option<String>,        // do último ai-title; None se inexistente
    pub model: Option<String>,        // do último assistant message
    pub started_at: i64,              // unix ms — primeiro evento
    pub last_activity: i64,           // unix ms — último evento
    pub message_count: u32,           // user + assistant events
    pub duration_ms: u64,             // soma de durationMs
    pub usage: AggregatedUsage,
}

pub struct AggregatedUsage {
    pub input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub output_tokens: u64,
}

pub struct ClaudeProjectState {
    pub project_path: String,             // canonical
    pub sessions: Vec<ClaudeSession>,     // sorted desc por last_activity
    pub active_session_id: Option<String>, // last_activity > now - 5min
    pub total_usage: AggregatedUsage,
}

pub struct TokenBucket {
    pub bucket_start: i64,    // unix ms — início do bucket (dia/mês/ano)
    pub usage: AggregatedUsage,
}

pub enum Granularity { Day, Month, Year }
```

### 2.3 Comandos Tauri

| Command | Args | Returns | Quando |
|---|---|---|---|
| `claude_snapshot` | — | `Vec<ClaudeProjectState>` | Boot do app, popula state inicial |
| `list_claude_sessions` | `project_path: String` | `Vec<ClaudeSession>` | Open drawer Claude tab |
| `aggregate_tokens` | `project_path, granularity, range_start, range_end` | `Vec<TokenBucket>` | Render do chart |
| `spawn_claude` | `path: String` | `Result<(), String>` | Click no botão "Spawn Claude here" |

### 2.4 Eventos

`claude-state` (payload `Vec<ClaudeProjectState>`) — emitido em diff. Diff = mudou `active_session_id` em algum project, ou `total_usage` em algum project, ou nova/removida sessão.

### 2.5 Pricing

Tabela hardcoded em Rust, marcada com data:

```rust
const PRICING_AS_OF_2026_05: &[(&str, ModelPricing)] = &[
    ("claude-opus-4-7", ModelPricing { input_per_1m: 15.00, cache_create_per_1m: 18.75, cache_read_per_1m: 1.50, output_per_1m: 75.00 }),
    ("claude-sonnet-4-6", ModelPricing { input_per_1m: 3.00, cache_create_per_1m: 3.75, cache_read_per_1m: 0.30, output_per_1m: 15.00 }),
    ("claude-haiku-4-5", ModelPricing { input_per_1m: 0.80, cache_create_per_1m: 1.00, cache_read_per_1m: 0.08, output_per_1m: 4.00 }),
];

const FALLBACK_PRICING: ModelPricing = /* Sonnet-equivalent */;
```

**Tokens são primários, cost é derivado.** Cost é função pura de `(usage, pricing_atual)`. Tabela de pricing pode ser atualizada sem reprocessar dados — todos os displays se reprecificam automaticamente.

```rust
fn cost_usd(usage: &AggregatedUsage, p: &ModelPricing) -> f64 {
    (usage.input_tokens as f64 * p.input_per_1m
     + usage.cache_creation_input_tokens as f64 * p.cache_create_per_1m
     + usage.cache_read_input_tokens as f64 * p.cache_read_per_1m
     + usage.output_tokens as f64 * p.output_per_1m) / 1_000_000.0
}
```

Sessão com mensagens de modelos diferentes: cost-per-message usa o `model` daquela mensagem específica, soma. Não há "modelo dominante".

---

## 3. Watcher + freshness

Estratégia híbrida:

1. **Boot:** scan completo de `~/.claude/projects/*`. Popula state.
2. **Notify recursivo** (crate `notify`): 1 watcher só na raiz `~/.claude/projects/`. Eventos modify/create disparam re-parse só do arquivo afetado.
3. **Fallback poll 30s:** task tokio paralela faz scan de mtime, processa o que escapou do notify.
4. **Erro graceful:** se notify falhar (ulimit raro, FS sem suporte), fallback pra polling 5s. Log warning. App não quebra.

**Active session = `last_activity > now - 5 minutes`** — derivado em read-time, não persistido.

---

## 4. UI Integration

### 4.1 ProjectCard / ProjectListItem

**Chip "Claude" novo** (ao lado do chip de script):

| Estado | Display |
|---|---|
| Ativo (last_activity ≤ 5min) | Dot `#a78bfa` pulsante + `Claude · 2min` |
| Histórico (sessões existem mas inativas) | Dot estático + `Claude · 12 sessões` |
| Cost ≥ threshold (≥ 100k tokens cumulative) | Adiciona `· 2.5M` ou similar |
| Sem sessões | Não renderiza (silêncio) |

**Botão "Spawn Claude here"** — ao lado do botão Files, antes do Run/Stop, na mesma linha de actions. Ícone: terminal + sparkle SVG inline.

### 4.2 ProjectDetailDrawer (renomeado de LogsDrawer)

```
┌─────────────────────────────────────────────┐
│ <project favicon> falcao-tcc       :5173 ↗ │
│ ─────────────────────────────────────────── │
│ [ Logs ]  [ Claude ]                        │
│ ─────────────────────────────────────────── │
│  ... conteúdo da tab ativa ...              │
└─────────────────────────────────────────────┘
```

Tab state persiste em localStorage por projeto (consistente com `falcao-launcher.viewMode`, `.autoOpenBrowser` etc). Tabs sem framer — só CSS transition.

### 4.3 Conteúdo da tab Claude

```
┌─────────────────────────────────────────────┐
│ Total: 12 sessões · 2.5M tokens · ≡ $23.40  │
│ ─────────────────────────────────────────── │
│ [ Dia · Mês · Ano ]                         │
│                                             │
│  ┌───────────────────────────────────┐      │
│  │   line chart Recharts (tokens)    │      │
│  │              ╱╲                    │      │
│  │            ╱   ╲      ╱╲          │      │
│  │   ──────╱──────╲────╱──╲────      │      │
│  └───────────────────────────────────┘      │
│ ─────────────────────────────────────────── │
│ Sessões                                     │
│                                             │
│ ● implementar painel de portas              │
│   05/05 · opus-4-7 · 1.2M ≡ $9.80 · 2h31m  │
│                                             │
│ ○ refinar settings menu                     │
│   05/05 · opus-4-7 · 340k ≡ $2.10 · 47m    │
│ ...                                         │
└─────────────────────────────────────────────┘
```

**Header summary:** total sessões, total tokens, total cost equivalente. Single line.

**Granularity toggle:** segmented button (mesmo estilo do grid/list toggle no header global, pra consistência).

| Granularidade | Range default | Bucket |
|---|---|---|
| Dia | últimos 30 dias | dia (ISO 8601) |
| Mês | últimos 12 meses | mês |
| Ano | últimos 5 anos | ano |

**Chart:** Recharts `<LineChart>` 1 line stroke `#a78bfa`. Hover tooltip: data + tokens + cost-equiv.

**Sessions list:** ordenada desc por last_activity. Cada linha:
- Bullet (filled `#a78bfa` se active, outline cinza se passada)
- Title (`aiTitle` ou "(sessão sem título)")
- Subline mono micro: `<data DD/MM> · <model> · <tokens humanizados> ≡ <cost> · <duração>`

**v1 sem ação no click da linha** — apenas visual. v2 pode "claude --resume <id>".

### 4.4 Spawn command

`external::spawn_claude(path)` em Rust:

```bash
ghostty --working-directory=<path> -e claude
```

Mesmo padrão de `external::open_in_terminal`. Fire-and-forget, stdio null.

---

## 5. Edge cases

- **Sessão órfã** (cwd não bate com nenhum projeto conhecido): silenciosamente ignorada.
- **Worktree mapping**: longest path wins (lógica existente do netstat).
- **JSONL malformado**: linha skipada, `warn!`, segue. Sessão não invalidada.
- **Sessão sem `aiTitle`**: fallback `"(sessão sem título)"`.
- **Sessão sem usage em nenhum evento**: cost displayed como `—`, nunca `$0.00`.
- **Modelo desconhecido** (lançamento novo Anthropic, sem pricing): fallback Sonnet-equivalent, flag `(estimado)` no tooltip.
- **Pasta `~/.claude/projects/` inexistente**: watcher não inicia, snapshot vazio. Sem crash.
- **JSONL grande (50MB+)**: parse line-by-line via `BufReader` (~200ms pra 5MB em debug). Re-parse incremental por mtime se virar gargalo.
- **`messageId` duplicado**: dedup ao agregar usage.
- **Encoded path duplicado** (slug colisão): confiar sempre no `cwd` canônico do JSONL.

---

## 6. Sequenciamento de implementação

| # | Passo | Checkpoint |
|---|---|---|
| 1 | Rust core (`claude.rs`): tipos, parser JSONL, agregação, cost calc, pricing table, **testes unitários** com fixture real | `cargo test` verde |
| 2 | Watcher: notify recursivo + fallback 30s + diff-based event | Modify em arquivo dispara evento |
| 3 | Comandos Tauri registrados em `lib.rs` | Console JS retorna data |
| 4 | Frontend types em `types.ts` | TS compila |
| 5 | `App.tsx` state + listener `claude-state` | Snapshot inicial popula |
| 6 | `ProjectCard` + `ProjectListItem`: chip + spawn button | Visual aparece nos projetos com sessões |
| 7 | Drawer tabs (refator `LogsDrawer` → `ProjectDetailDrawer`) | Alternar tabs funciona |
| 8 | Sessions list component | Lista renderiza com fixture |
| 9 | Chart Recharts + granularity toggle | Chart real com dados reais |
| 10 | Polish + manual QA (zero sessões, animações, light mode) | OK do Falcão |

### Distribuição em subagents

- **Agent A (Rust):** passos 1, 2, 3
- **Agent B (Frontend cards):** passos 4, 5, 6 (em paralelo a A após tipos saírem)
- **Agent C (Drawer + chart):** passos 7, 8, 9
- **CTO (eu, Opus):** coordeno, integro, passo 10

### Estimativa

3-4 dias de trabalho, dependendo de quanto tempo gastamos por sessão.

---

## 7. Testing

### Rust unit tests (em `claude.rs`)

- `test_parse_jsonl_real_session` — parsea uma das sessões reais do `~/.claude/projects/` como fixture (copiada pra `tests/fixtures/`)
- `test_cost_calc_opus` — usage conhecida × pricing → cost esperado
- `test_cost_calc_multimodel_session` — sessão com Opus + Sonnet, cost = soma
- `test_aggregate_tokens_day_bucket` — sessões em 3 dias diferentes → 3 buckets
- `test_aggregate_tokens_month_bucket` — agregação cross-month
- `test_active_detection` — last_activity 4min atrás = active; 6min = inativo
- `test_orphan_session_skipped` — cwd inválido → não retorna no snapshot
- `test_jsonl_malformed_line_skipped` — linha quebrada não invalida sessão

### Manual QA (Falcão)

- Reabrir launcher → chip aparece nos projetos com sessões existentes
- Abrir drawer → tab Claude funciona, lista popula
- Toggle granularidade → chart muda buckets
- Spawn Claude here → ghostty abre com claude rodando
- Light mode → indigo `#a78bfa` legível em background claro

---

## 8. Tokens de design adicionados

Indigo Claude — adicionar ao `@theme {}` em `src/App.css`:

```css
--color-claude-primary: #a78bfa;     /* dot ativo, line do chart, brand cor da família Claude */
--color-claude-soft: rgba(167, 139, 250, 0.13);  /* bg do chip, hover suave */
```

Usar nas peças: chip dot, chart line stroke, hover sutil de linha de sessão. Light mode pode precisar de variant `#7c3aed` (mais saturado em fundo claro) — testar e ajustar.

---

## 9. Decisões já tomadas (registro)

- Tokens são métrica primária; cost é função pura derivada (imune a mudanças de pricing)
- Pricing table é hardcoded com data; pode ser atualizada manualmente
- Active = 5min sliding window
- Granularity toggle: dia (30d) / mês (12m) / ano (5y) — sem date-range custom no v1
- Click em sessão sem ação no v1 (resume é v2)
- Diff por sessão (feature 6) é Full, não Core — deferida

---

## 10. Próximo passo

Invocar **writing-plans** skill pra produzir plano de implementação detalhado a partir desse spec.
