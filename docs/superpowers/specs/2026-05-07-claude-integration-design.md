# Sprint 4 — Integração Claude no modo análise

**Data:** 2026-05-07
**Autor:** Falcão (supervisão) + Claude (escrita)
**Status:** rascunho — aguardando aprovação do Falcão

---

## Contexto

Sprint 3 entregou o "modo análise" com hook `useAnalysisContext` que agrega state serializável (range, charts com séries, logs do período, layout). Foi explicitamente desenhado pra Sprint 4 consumir sem refactor.

Sprint 4 "liga o cabo": botão **"🤖 Investigar com Claude"** no header do `AnalysisPage` que abre Claude Code numa janela Ghostty nova com o contexto da investigação atual já formatado como prompt markdown estruturado, partindo do diretório do projeto sendo investigado.

**Princípio orientador:** reutilizar tudo que já existe — `spawn_claude` pattern, sistema de Claude awareness que trackeia sessões, hook `useAnalysisContext`. Sprint pequena e focada (~1-2 dias).

## Objetivos

1. Botão "🤖 Investigar com Claude" no header do `AnalysisPage`, ao lado de "← Voltar" e dos botões de Layout
2. Modal com textarea pra user digitar a pergunta antes de spawnar
3. Serialização do `AnalysisContext` em prompt Markdown estruturado (Contexto / Métricas / Logs / Pergunta)
4. Spawn de `ghostty + claude` partindo de diretório auto-detectado pela métrica primária (container → projeto local; VM/Hetzner → launcher)
5. Mecanismo robusto pra prompts grandes (>100KB) via stdin do arquivo temp em `/tmp`
6. Sessão Claude resultante é trackeada automaticamente pelo sistema de Claude awareness existente

## Não-objetivos (Sprint 4)

- API direta da Anthropic (descartado em D1)
- MCP server (descartado em D1 — overkill)
- Modal com sugestões predefinidas (descartado em D5 — só textarea livre)
- Botão Investigar no `VmContainerDrawer`/`StackDrawer` (descartado em D6 — só `AnalysisPage`)
- Histórico de investigações no launcher (cada spawn é independente; histórico vive na pasta do Claude Code)
- Resposta inline do Claude dentro do launcher (sem API direta = sem streaming inline)
- Resumo estatístico de séries (descartado em D2 — Falcão escolheu envio bruto)

## Decisões de design

### D1 — Caminho: spawn de Claude Code CLI

**Decisão:** botão dispara `ghostty -e bash -c "cd <dir> && claude < <tmp-file>"`. Reusa subscription Claude Code do Falcão; conversa vira sessão Claude que o launcher já trackeia via `ClaudeChip`.

**Por que não API direta:** custos por uso além da subscription, exige gerenciar API key, e exigiria UI custom pra streaming/respostas — investimento desproporcional pro escopo.

**Por que não MCP server:** padrão moderno mas adiciona ~3-5 dias de complexidade pra uso single-user. Vale revisitar quando tiver multi-user ou Claude precisar consultar contexto on-demand.

**Por que não copy-paste manual:** UX pior por 1 click extra, sem ganho técnico.

### D2 — Contexto: tudo serializado (séries cruas + logs completos)

**Decisão:** prompt inclui o `AnalysisContext` inteiro — range, todas as séries de pontos brutos, logs completos.

**Implicação técnica:** prompts podem chegar a ~200KB worst-case (6 charts × 360 pontos + 2000 linhas de log). Argv tem limite ~128KB Linux. Solução: stdin via arquivo temp.

**Por que não resumo estatístico:** Falcão optou por máxima precisão. Trade-off aceito — Claude paga em tokens mas tem contexto completo pra análise. Se virar problema de custo, decisão pode ser revisitada com `--summary` toggle.

### D3 — Diretório: auto-detect baseado na métrica primária

**Decisão:** o "primeiro chart" do `AnalysisContext` (`charts[0].metric`) determina o diretório onde Claude abre.

```typescript
function resolveTargetDir(metricRef: MetricRef): string {
  const home = "/home/falcao";
  if (metricRef.kind === "container") {
    return `${home}/Projects/${metricRef.resource}`;  // convenção: container name = projeto local
  }
  return `${home}/Projects/falcao-launcher`;  // VM/Hetzner default
}
```

**Fallback no Rust:** se diretório resolvido não existe, usa `~/Projects/falcao-launcher` automaticamente + log warn. UI não distingue (transparente pro user).

**Por que não diretório dedicado:** Claude perde contexto do código (CLAUDE.md, agent.md, fontes). Investigação fica teórica. Auto-detect resolve majoritariamente.

### D4 — Estilo: prompt em Markdown estruturado

**Decisão:** template fixo com seções `## Contexto`, `## Métricas observadas` (subseção por chart), `## Logs do período`, `## Pergunta`.

**Por que Markdown:** Claude Code consome melhor markdown estruturado em prompts. JSON seria denso mas tratado como texto bruto. Markdown também serve pra revisar/compartilhar a investigação depois.

**Séries em CSV dentro de fenced code block:** `ts,value` cabeçalho + 1 linha por ponto. Compacto e Claude lê bem.

**Logs em fenced code block puro** (sem syntax highlight) — preserva timestamps e estrutura nativa do Docker.

### D5 — Input: modal pequeno com textarea

**Decisão:** click no botão abre `ClaudeInvestigationModal` (componente novo). Modal mostra resumo do contexto + textarea "O que investigar?" + botões `[Cancelar]` `[🚀 Spawnar Claude]`. Spawnar fica disabled enquanto textarea vazia.

**Por que modal e não spawn direto:** pergunta default genérica ("analise os dados") perde valor — Claude precisa direção. 1 step extra é troca aceitável.

**Por que não sugestões predefinidas:** complexidade extra (~1 dia) sem demanda concreta. Pode adicionar depois se virar gargalo.

### D6 — Local: só no header do AnalysisPage

**Decisão:** único ponto de entrada. Drawers (`VmContainerDrawer`, `StackDrawer`) já têm botão "🔍 Investigar período" (Sprint 3) que abre o modo análise — fluxo natural é entrar no modo análise primeiro, brush refinar, então perguntar pro Claude.

**Por que não nos drawers:** contexto enviado seria mais pobre (sem brush, sem multiple charts). Investigação fragmentada.

**Por que não no painel de logs:** caso de uso "que erro é esse?" funciona com botão único do header (logs já fazem parte do AnalysisContext).

## Arquitetura

```
┌────────────────────────────────────────────────────────────────────────────┐
│ AnalysisPage (Sprint 3)                                                    │
│                                                                            │
│  Header: [← Voltar]  [🤖 Investigar com Claude]  [Layout selector...]    │
│                       └──────┬──────────────────────┘                      │
│  Charts grid                  │ click                                       │
│  Logs panel                   ▼                                             │
│                       ┌─────────────────────────────────┐                  │
│                       │ ClaudeInvestigationModal (NEW)  │                  │
│                       │  - Header                       │                  │
│                       │  - Resumo do contexto           │                  │
│                       │  - <textarea> autofocus         │                  │
│                       │  - [Cancelar] [🚀 Spawnar]     │                  │
│                       └────────────┬────────────────────┘                  │
│                                    │ click Spawnar                          │
│                                    ▼                                        │
│   serializeContextToMarkdown(context, question) → string (~200KB)          │
│                                    │                                        │
│                                    ▼                                        │
│   invoke("spawn_claude_investigation", { promptMarkdown, targetDir })     │
└────────────────────────────────────│───────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ src-tauri/src/external.rs (Rust)                                        │
│                                                                         │
│ #[tauri::command]                                                       │
│ pub async fn spawn_claude_investigation(                                │
│     prompt_markdown: String,                                            │
│     target_dir: String,                                                 │
│ ) -> Result<(), String>                                                 │
│                                                                         │
│ 1. Validar target_dir (existe + é diretório); fallback launcher se não │
│ 2. Escrever /tmp/falcao-investigation-<uuid>.md (chmod 600)             │
│ 3. Spawn fire-and-forget:                                               │
│    ghostty --working-directory=<dir> -e bash -c \                       │
│      "claude < /tmp/<uuid>.md; rm -f /tmp/<uuid>.md"                    │
│    (PATH inclui ~/.local/bin)                                           │
│ 4. Retornar Ok(())                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                          Ghostty + Claude Code
                          (sessão registrada
                          ~/.claude/projects/...)
                                     │
                                     ▼
                  Sistema existente de Claude awareness
                  detecta sessão nova → ClaudeChip aparece
                  (sem código novo necessário)
```

## Componentes

### `src/components/ClaudeInvestigationModal.tsx` (NEW)

Modal pequeno, ~150 linhas. Props:
```typescript
interface Props {
  context: AnalysisContext;            // do useAnalysisContext()
  primaryMetric: MetricRef;            // primeiro chart, pra título e auto-detect dir
  open: boolean;
  onClose: () => void;
}
```

UI:
- Overlay escuro + modal centralizado (reusa pattern do `ProjectConfigModal` existente)
- Header: "🤖 Investigar com Claude · `<primaryMetric label>`"
- Resumo: "N charts · range X → Y (Z min) · M linhas de logs"
- `<textarea>` autoFocus, ~5 linhas, placeholder *"Ex: Por que o pico de CPU às 14:35?"*
- Botão "🚀 Spawnar Claude" disabled se textarea vazia
- Esc/Cancelar fecha; submit chama `serializeContextToMarkdown` + `invoke("spawn_claude_investigation")`
- Estado de loading (spinner) durante invoke; erro inline se falhar
- Após sucesso: modal fecha automaticamente; toast pode ou não — decisão da implementação

### `src/lib/serializeAnalysis.ts` (NEW)

Função pura:
```typescript
export function serializeContextToMarkdown(
  context: AnalysisContext,
  question: string,
): string
```

Sem efeitos. Sem fetches. Determinística — mesmos inputs = mesmo output. Trivial de testar (não precisa de mocks).

### `src/lib/resolveTargetDir.ts` (NEW)

Função pura:
```typescript
export function resolveTargetDir(metric: MetricRef): string
```

Aplica a regra D3. Frontend não checa fs (Tauri WebKit não tem `fs`); Rust valida e fallback.

### `src-tauri/src/external.rs` (MODIFIED)

Adiciona comando `spawn_claude_investigation`. Reusa pattern de `spawn_claude` existente:
- `Command::new("ghostty")` com `--working-directory` + `-e bash -c "..."`
- PATH com `~/.local/bin` prepended (gotcha do GNOME-launched já corrigido em `spawn_claude`)
- Fire-and-forget — não aguarda exit (Ghostty é GUI process)
- Validação de `target_dir`: `Path::is_dir()` antes de spawnar
- Fallback ao launcher dir se inválido

### `src-tauri/src/lib.rs` (MODIFIED)

Registra `spawn_claude_investigation` no `tauri::generate_handler!`.

### `src/components/AnalysisPage.tsx` (MODIFIED)

- Importa `ClaudeInvestigationModal`
- `useAnalysisContext` agora **retorna** o context (atualmente é descartado em `_ = useAnalysisContext(...)`)
- State `claudeModalOpen: boolean`
- State derivado `analysisReady: boolean` — true se todos os charts carregaram dados
- Botão "🤖 Investigar com Claude" no header (entre `← Voltar` e `<AnalysisLayoutPicker>`)
  - Disabled se `!analysisReady` com tooltip "Aguardando dados…"
- Renderiza `<ClaudeInvestigationModal>` com `<AnimatePresence>`

## Modelo do prompt (template Markdown completo)

```markdown
# Investigação · <primaryMetric label> · <ISO timestamp now>

## Contexto

- **Range:** <start ISO> → <end ISO> (<duração formatada>)
- **Preset:** <preset> carregado<, brush ativo selecionando <duração> se aplicável>
- **Layout:** <name ou "rascunho não salvo">

## Métricas observadas

### <chart 1: kind · resource? · metric>
Bucket: <raw 15s | 1 minute | etc.> · <N> pontos
```csv
ts,value
2026-05-07T14:30:00Z,0.42
...
```

### <chart 2: ...>
...

## Logs do período · container: <name>

```
<output bruto do docker logs --since/--until ...>
```

## Pergunta

<conteúdo da textarea do user>

---

*Investigação gerada pelo falcao-launcher · modo análise · 2026-05-07*
```

**Truncamento defensivo:**
- Se `series.length > 1000` por chart: trunca em 1000 + linha "... (truncated, N total points)"
- Se `logs.text.length > 200_000` chars: trunca + "... (truncated by launcher)"

## Edge cases e error handling

| Cenário | Comportamento |
|---|---|
| `claude` não está no PATH | Spawn falha; toast/inline "Claude Code não encontrado em ~/.local/bin/claude — instale via npm" |
| `ghostty` não instalado | Spawn falha; toast/inline "Ghostty não encontrado — instale via `pacman -S ghostty`" |
| `target_dir` não existe | Rust faz fallback automático pra `~/Projects/falcao-launcher`; warn no log |
| `target_dir` é arquivo (não dir) | Rust rejeita com erro; toast "destino inválido" |
| `/tmp` cheio | `write` falha; toast "não foi possível escrever prompt — disco cheio?" |
| Pergunta vazia | Botão "Spawnar" disabled |
| Prompt > 2 MB (worst-case extremo) | Front trunca logs em 1500 linhas + warn no preview do modal |
| `useAnalysisContext` ainda carregando | Botão "Investigar com Claude" no header fica disabled com tooltip |
| Cleanup do `/tmp` | `rm -f` no fim do bash command. Se Claude crashar antes, OS limpa no reboot |
| User fecha launcher antes de Claude consumir | Ghostty é processo independente — Claude continua na janela aberta |
| Múltiplos clicks (spawn paralelo) | Cada click = nova janela Ghostty. Sem dedup (cada investigação é independente) |
| Permissões `/tmp/falcao-investigation-*.md` | chmod 600 explícito (só user lê/escreve) |

## Testing

**Rust (`cargo test`):**
- `validates_target_dir_exists` — `Path::is_dir()` retorna `true` pra dir conhecido (ex: `/tmp`)
- `falls_back_when_target_missing` — passa path inexistente, helper retorna fallback dir
- `escreve_prompt_em_tmp` — usa `tempfile` crate ou path temp custom; verifica conteúdo + permissions

Sem teste de integração GUI (Ghostty/Claude precisariam de display) — segue padrão `#[ignore]` do projeto.

**Frontend:**
- `pnpm exec tsc --noEmit` — valida tipos do modal, props, MetricRef discriminated union narrowing
- Sem testes unitários TS (alinhado com convenção do projeto)
- Smoke manual via launcher real:
  1. Sem analysisContext (charts carregando) → botão disabled
  2. Click com context → modal abre, textarea autofocus
  3. Spawnar com pergunta vazia → button disabled
  4. Spawnar com pergunta → ghostty abre + Claude consome prompt + sessão visível no launcher (ClaudeChip)
  5. Auto-detect: `falcao-financas` container → Claude em `~/Projects/falcao-financas/`
  6. Fallback: investigar VM Load → Claude em `~/Projects/falcao-launcher/`

## Critérios de aceite

A sprint só fecha se:

1. ✅ Botão "🤖 Investigar com Claude" aparece no header do `AnalysisPage`
2. ✅ Botão fica disabled enquanto charts carregam
3. ✅ Click abre `ClaudeInvestigationModal` com textarea autofocus
4. ✅ Resumo do contexto correto ("N charts · range X → Y · M linhas de logs")
5. ✅ `serializeContextToMarkdown` produz markdown válido com 4 seções obrigatórias
6. ✅ Tamanho do prompt sem limite efetivo (testado >100KB via stdin do arquivo temp)
7. ✅ Spawnar abre Ghostty + Claude no diretório correto (auto-detect funciona pra `falcao-financas` container)
8. ✅ Fallback ao launcher dir funciona se auto-detect aponta pra dir inexistente
9. ✅ Prompt temp em `/tmp/falcao-investigation-<uuid>.md` chmod 600, deletado após Claude consumir
10. ✅ Sessão Claude aparece no `ClaudeChip` do projeto destino (sistema existente)
11. ✅ Type-check + cargo test passam (3 testes Rust novos)
12. ✅ Documentação atualizada (agent.md de external.rs / components / lib + CLAUDE.md)

## Riscos

1. **Claude Code CLI não consome bem stdin com >100KB** — em teoria deveria, mas não testado. Mitigação: se detectado, fallback pra arquivo argument (`claude --file <path>` se a flag existir, ou copy-paste pelo user).
2. **Ghostty `--working-directory` flag pode ter mudado** — testado em `spawn_claude` atual, mas vale validar com versão atual instalada.
3. **PATH `~/.local/bin` injection no shell command** — pattern já usado em `spawn_claude`, se quebrar lá, quebra aqui também.
4. **Auto-detect errado:** container `caddy` (não tem projeto local em `~/Projects/caddy`) → fallback ao launcher. Aceito.
5. **Sensibilidade dos logs:** logs podem conter informações sensíveis (tokens, senhas em stack traces). Por enquanto vai bruto pro Claude — Falcão decide se vale filtrar antes. Não-objetivo nessa sprint.

## Próximos passos pós-aprovação

→ Plan TDD em `docs/superpowers/plans/2026-05-07-claude-integration.md` quebrando em ~6-8 tasks bite-sized:
- A1: Comando Rust `spawn_claude_investigation` + 3 testes
- B1: `serializeAnalysis.ts` + `resolveTargetDir.ts`
- C1: `ClaudeInvestigationModal.tsx`
- C2: Botão e modal integration em `AnalysisPage.tsx` (incluindo retornar context do hook)
- D1: Smoke build + reinstall
- E1-E3: Docs (agent.md + CLAUDE.md + VALIDATION.md) + PR

Tempo estimado: ~3-4h sequencial; ~2h com paralelismo Rust ‖ TS.
