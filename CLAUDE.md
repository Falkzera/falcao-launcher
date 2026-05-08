# falcao-launcher

App desktop em **Tauri 2 + React 19 + TypeScript** que lê `~/Projects/`, lista cada projeto como card num grid, e roda `pnpm run <script>` com supervisão de processo, captura de logs ao vivo, detecção de porta e abertura automática do browser. Repositório público: **https://github.com/Falkzera/falcao-launcher**.

> Já há uma skill viva em `~/.claude/skills/falcao-launcher/SKILL.md` com decisões arquiteturais, roadmap em fases, gotchas e diário de bordo. Prefira ler a skill antes de mexer aqui.

## Feature: VM Monitor (Fase 1)

Aba "VM" do launcher mostra status da VM Hetzner + containers + histórico de métricas em tempo real.

- **Spec:** `docs/superpowers/specs/2026-05-06-vm-monitor-fase-1-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-06-vm-monitor-fase-1.md`
- **Validation:** `docs/superpowers/vm-migrations/VALIDATION.md`
- **Stack:** Postgres+TimescaleDB na VM (porta 5432 local-only, em `/opt/falcao-monitor/`) + agente Rust em systemd user service (`falcao-monitor-agent.service`, poll 15s) + SSH tunnel (`ssh -L`) → tokio-postgres (read-only) + Recharts no front.
- **Skills relevantes:** `~/.claude/skills/falcao-hetzner/SKILL.md` (sub-projeto E — VM, hardening, deploy) e `~/.claude/skills/falcao-default/SKILL.md` (regra do agent.md).

### Crates novos
- `src-tauri/crates/monitor-shared/` — tipos comuns entre launcher e agente (`MetricRow`, `MetricSource`, constantes).
- `src-tauri/crates/monitor-agent/` — binário standalone do coletor 24/7. Deploy: `./scripts/deploy-monitor-agent.sh`.

### Componentes frontend novos
- `src/components/VmTab.tsx` — entry da aba VM (storytelling: bloco INFRA + bloco APLICAÇÕES).
- `src/components/VmHeader.tsx` — header de status (heartbeat, load, RAM, custo, barras).
- `src/components/VmContainerGrid.tsx` + `VmContainerCard.tsx` — grid de containers com CPU/RAM por card.
- `src/components/VmContainerDrawer.tsx` — drawer de detalhe (charts + logs on-demand).
- `src/components/VmMetricChart.tsx` — chart Recharts reutilizável.

## Feature: Vercel stacks (Sprint 2)

Aba "VM" agora agrega **frontend Vercel + backend container** numa visão unificada de stack em produção. Convenção: container Docker declara label `monitor.stack=<nome>` no `docker-compose.yml` — agente lê via `docker inspect` e propaga em `metrics.labels`. Coletor Vercel novo lista todos os projetos da conta automaticamente (sem allowlist) via REST API + Bearer token. Frontend cruza as duas dimensões em query-time (nome igual = mesma stack).

- **Spec:** `docs/superpowers/specs/2026-05-07-vercel-stacks-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-07-vercel-stacks.md`
- **Migration:** `docs/superpowers/vm-migrations/007_vercel_deployments.sql` (hypertable, retention 90d, compression 7d).
- **Token Vercel:** `/home/falcao/.config/falcao-monitor/.env` na VM (`VERCEL_TOKEN=…`, chmod 600), carregado via systemd `EnvironmentFile=`.
- **Agente:** bumped pra v0.2.0 — coletor Vercel em task paralela (poll 5min) + label propagation no container collector.

### Componentes frontend novos (Sprint 2)
- `src/components/StackGrid.tsx` — grid de stacks ativas + state do drawer + body scroll lock.
- `src/components/StackCard.tsx` — card único agregando 3 sub-blocos (Vercel + Backend + Endpoint). Clicável.
- `src/components/StackDrawer.tsx` — drawer fullscreen com Vercel histórico + container charts/logs + endpoint uptime grid.
- `src/components/VercelStatusBadge.tsx` — dot + label de state (READY/ERROR/BUILDING/QUEUED/CANCELED).
- `src/components/Loading.tsx` — primitivos reutilizáveis: `<Spinner>`, `<LoadingMessages>`, `<DrawerLoadingOverlay>`, `<InlineLoading>`.

## Feature: Modo análise (Sprint 3)

Click num `VmMetricChart` ou no botão "🔍 Investigar período" dos drawers (Container/Stack) abre uma página dedicada de análise dentro da aba VM. Grid drag-drop com `react-grid-layout` (responsivo lg/md/sm), brush selection sincronizado entre charts, logs do período sob demanda, layouts nomeados em localStorage com export/import JSON.

- **Spec:** `docs/superpowers/specs/2026-05-07-modo-analise-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-07-modo-analise.md`
- **Backend novo:** `monitor_fetch_logs_range` (Tauri command, `docker logs --since/--until` via SSH, max 24h, regex container).
- **Stack adicional:** `react-grid-layout@^1.5` + shim de types em `src/types/react-grid-layout.d.ts` (a stub `@types/react-grid-layout` é deprecated).
- **Persistência:** localStorage `analysis:layouts:v1` versionado (schema migration tolerante); export/import JSON pra portar entre máquinas.
- **Hook futuro:** `useAnalysisContext` centraliza estado serializável pra integração Claude (Sprint 4) — sem UI Claude por enquanto.
- **Mobile (<600px):** modo viewer — charts em stack vertical sem drag-drop, brush desabilitado.

### Componentes frontend novos (Sprint 3)
- `src/components/AnalysisPage.tsx` — orquestrador (state global preset/brushRange/charts/hover/logs).
- `src/components/AnalysisGrid.tsx` — wrapper `<ResponsiveReactGridLayout>` com 3 breakpoints.
- `src/components/AnalysisChartSlot.tsx` — slot Recharts + Brush + crosshair sync.
- `src/components/AnalysisLogsPanel.tsx` — fetch manual + selectbox container.
- `src/components/AnalysisLayoutPicker.tsx` — gerenciamento de layouts no header.
- `src/components/MetricPicker.tsx` — select agrupado VM/Hetzner/Containers.

### Hooks novos (Sprint 3)
- `src/lib/useAnalysisLayouts.ts` — CRUD localStorage + export/import + schema migration tolerante.
- `src/lib/useAnalysisContext.ts` — agregador serializável pra Sprint 4 (Claude).

## Feature: Investigar com Claude (Sprint 4)

Botão **"🤖 Investigar com Claude"** no header do `AnalysisPage` que abre Claude Code numa janela Ghostty nova com o `AnalysisContext` atual já formatado como prompt Markdown estruturado, partindo do diretório do projeto sendo investigado (auto-detect).

- **Spec:** `docs/superpowers/specs/2026-05-07-claude-integration-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-07-claude-integration.md`
- **Backend novo:** `spawn_claude_investigation` em `src-tauri/src/external.rs`. Reusa pattern de `spawn_claude` (Ghostty + PATH fix `~/.local/bin`). Mecanismo: `/tmp/falcao-investigation-<uuid>.md` chmod 600 + `bash -c "claude < <file>; rm -f <file>"` (stdin redirect dribla argv limit pra prompts grandes ~200KB).
- **Auto-detect:** `container.resource` → `~/Projects/<name>`; `vm`/`hetzner` → `~/Projects/falcao-launcher` (fallback).
- **Reuso:** `useAnalysisContext` (Sprint 3) consumido literalmente. Sessão Claude resultante é trackeada automaticamente pelo sistema de Claude awareness via `ClaudeChip` na aba Projetos.

### Componentes/hooks novos (Sprint 4)
- `src/components/ClaudeInvestigationModal.tsx` — modal com textarea pra pergunta + botão Spawnar.
- `src/lib/serializeAnalysis.ts` — gerador Markdown estruturado + `estimatePromptSize`.
- `src/lib/resolveTargetDir.ts` — auto-detect do diretório alvo.

## Feature: Snyk-like — vulnerabilidades cross-repo (Sprint B1)

Aba **"Segurança"** no topbar entre Skills e VM. Lista CVEs vindos de 3 fontes hybrid:
- **Dependabot alerts** dos repos `Falkzera/*` (auto-discovery via `gh api /user/repos`)
- **Trivy** scans nas imagens Docker rodando na VM (`caddy`, `falcao-monitor-db`, `falcao-financas-app`)
- **GHSA cross-cutting** advisories que afetam packages dos teus repos

Coleta diária via cron (GH Actions cron 06:07 UTC pra deps/GHSA + systemd timer na VM pra Trivy) + botão "🔄 Re-escanear agora" no header da aba.

- **Spec:** `docs/superpowers/specs/2026-05-08-snyk-like-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-08-snyk-like.md`
- **Migration:** `docs/superpowers/vm-migrations/008_vulnerabilities.sql` (hypertable, retention 90d, compression 7d)
- **GitHub PAT:** `GH_PAT_SECURITY` em GitHub Secrets + `~/.config/falcao-monitor/.env` na VM
- **Trivy install:** `curl -sfL .../install.sh | sudo sh -s -- -b /usr/local/bin` na VM (1x manual)
- **Reuso:** SSH key dedicada `falcao-monitor-push` da Sprint 2 health checks (mesma chave + secrets)
- **Dismiss persistente:** `~/.config/falcao-launcher/config.json` campo `dismissed_vulnerabilities` com `fix_version_at_time` — CVE reaparece quando `fix_version` muda

### Componentes novos (Sprint B1)
- `src/components/SecurityTab.tsx` — orquestrador da aba (filtros + lista + scan trigger)
- `src/components/VulnerabilityRow.tsx` — item individual com severity chip + dismiss
- `src/components/SecurityChip.tsx` — chip compacto pros ProjectCards (Critical/High count)
- `src/components/SecurityScanProgress.tsx` — overlay com streaming durante scan on-demand

### Backend novo
- `src-tauri/src/monitor/security.rs` — queries SELECT (list_vulnerabilities + vuln_summary + vuln_count_by_repo)
- `src-tauri/src/external.rs` — `trigger_trivy_scan_on_vm` (SSH + emit events) + `trigger_dependabot_scan_via_gh`
- `src-tauri/src/config.rs` — `dismissed_vulnerabilities: HashMap<String, DismissedVuln>` + 3 comandos

### Scripts novos
- `scripts/scan-dependabot.sh` — gh api auto-discovery + GHSA cross-cutting
- `scripts/push-vulnerabilities.sh` — pipe SSH command-restricted
- `.github/workflows/security-scan.yml` — cron 0 7 6 * * * + workflow_dispatch
- `/home/falcao/.local/bin/scan-trivy.sh` (na VM) + `falcao-trivy-scanner.timer` (systemd user, daily)

## Documentação por pasta (agent.md)

Toda pasta com código deste projeto tem um `.agent.md` que outra LLM lê antes de mexer ali. Ver regras completas em `~/.claude/skills/falcao-default/SKILL.md` (seção "agent.md").

## Como rodar

```bash
# Dev (HMR no React, recompila Rust em ~5s)
pnpm tauri dev

# Build release (binário standalone)
pnpm tauri build --bundles deb,rpm

# Type-check rápido sem rodar nada
pnpm exec tsc --noEmit

# Testes Rust
cargo test --manifest-path src-tauri/Cargo.toml
```

O **app já está instalado** no GNOME — abrir via Activities → "Falcão Launcher" (binário em `~/.local/bin/falcao-launcher`). Ciclo de update: `pnpm tauri build --bundles deb,rpm` + `rm ~/.local/bin/falcao-launcher && cp src-tauri/target/release/falcao-launcher ~/.local/bin/falcao-launcher`.

## Stack

- **Frontend**: Vite 7, React 19, TypeScript 5.8, Tailwind v4 (sem `tailwind.config.js` — tokens em `src/App.css` via `@theme {}`), **Framer Motion 12** (motion/microinterações).
- **Backend**: Rust (edition 2021), Tauri 2.10, tokio (process/io-util/sync), `freedesktop-icons` (resolução de ícones do tema do sistema).
- **Identifier**: `com.falcao.launcher`.
- **Package manager**: pnpm.
- **Design system**: segue `~/Projects/frontend-falcao` — Plus Jakarta Sans (UI), JetBrains Mono (paths/scripts/portas), Fraunces (display, classe `.page-title`), accent **Amber** (`#f59e0b`, preserva laranja do ícone do app).

## Arquitetura em uma frase

`scan_projects` lê `~/Projects` no Rust + paths extras da config, frontend renderiza grid; `start_project` aloca portas livres (override via config), injeta `PORT`/`BACKEND_PORT` no env, spawna `pnpm run <script>` com `process_group(0)` (matar árvore inteira), supervisor task com `tokio::select!` lê stdout/stderr, regex extrai porta (filtrando a do backend quando configurada), eventos `log` / `status` / `port` / `port-allocated` chegam no React via `listen()`, drawer lateral mostra logs.

## Convenções importantes

- **Não escrever Rust complexo sem alinhar com o Falcão.** Ele é copiloto, não conduz Rust. Explicar conceitos novos com 1-2 frases.
- **Tudo em PT-BR** com o Falcão.
- **Mexer em `src-tauri/src/process.rs` é sensível** — bugs deixam processos zumbis. Ao alterar lifecycle (start/stop/wait), rodar `cargo test` antes de claim-ar como pronto.
- **Tailwind v4 não tem `tailwind.config.js`.** Tokens canônicos ficam em `src/App.css` no bloco `@theme {}` com prefixo `--color-*`, `--font-*`, `--radius-*`. Vars CSS são consumidas como classes (`bg-bg-primary`) ou diretamente (`bg-[var(--color-accent-primary)]`).
- **Tokens semânticos** seguem o design system Falcão: `--color-bg-primary`, `--color-bg-secondary`, `--color-bg-card` (glass), `--color-text-primary`, `--color-accent-primary` (Amber), etc. Light mode automático via `@media (prefers-color-scheme: light)` no `App.css`.
- **Tauri serializa structs em snake_case por padrão.** Tipos TS devem casar (`detected_script`, não `detectedScript`). Args de comandos do JS pra Rust SÃO auto-convertidos camelCase ↔ snake_case (mas payloads de eventos não são).
- **Ícones embedam em build-time** (`generate_context!()`). Trocar arquivos em `src-tauri/icons/` exige `touch src-tauri/src/lib.rs` pra forçar recompile.
- **Configuração do usuário fica em `~/.config/falcao-launcher/config.json`** (fora do repo, nunca vai pro git). Estrutura: `{ version, projects: { [id]: { frontend_port?, backend_port?, custom_icon_path? } }, hidden: string[], extra_paths: string[] }`.
- **Secrets do usuário ficam em `~/.config/falcao-launcher/.env`** (chmod 600, manual, nunca no repo). Hoje hospeda `MONITOR_READER_PASSWORD` (lida pelo `MonitorState::new()` como fallback quando a env var não está exportada — caso típico: app lançado via atalho do GNOME que não herda env do shell). Formato `.env` simples (linhas `KEY=VALUE`, aceita aspas, `#` é comentário).
- **Secrets do agente Vercel ficam em `/home/falcao/.config/falcao-monitor/.env` na VM** (chmod 600). Hospeda `VERCEL_TOKEN` lido pelo `monitor-agent` via systemd `EnvironmentFile=-`. Token tem scope read-only, full account, criado em https://vercel.com/account/tokens.

## Layout dos `.agent.md`

Cada pasta lógica do projeto tem um `.agent.md` explicando o que vive ali. Ler sempre que for editar a pasta — economiza descoberta:

| Pasta | Tópico |
|---|---|
| `./` (este `CLAUDE.md`) | overview do projeto |
| `public/` | assets servidos pelo Vite na raiz |
| `src/` | entrypoint React, App, tema |
| `src/assets/` | imagens importadas via JS |
| `src/components/` | componentes React reutilizáveis |
| `src/lib/` | utilitários TS puros (parsers, helpers de cálculo) |
| `src/styles/` | variants Framer Motion compartilhadas |
| `src/types/` | tipos TS por feature (espelham serde do Rust) |
| `src-tauri/` | tudo do shell nativo Tauri |
| `src-tauri/src/` | código Rust (commands, supervisor, scanner, config, ports, external, icon) |
| `src-tauri/src/monitor/` | SSH tunnel + queries Postgres + commands Tauri do VM Monitor |
| `src-tauri/crates/` | subcrates do workspace Cargo (monitor-shared, monitor-agent) |
| `src-tauri/crates/monitor-shared/` | tipos comuns launcher ↔ agente |
| `src-tauri/crates/monitor-agent/` | binário do coletor 24/7 (roda na VM) |
| `src-tauri/crates/monitor-agent/src/collectors/` | coletores VM/container/Hetzner |
| `src-tauri/capabilities/` | permissões dos plugins Tauri |
| `src-tauri/icons/` | ícones do bundle nativo |

## Estado conhecido

Roadmap completo (fases 1–5 + empacotamento + sub-projetos D/A/B) na skill. Features atuais: scan + run/stop/logs + detecção de porta + auto-open browser + favicons + busca + atalhos + auto-allocação de portas + override por projeto + esconder/adicionar projetos + abrir VSCode/Ghostty/Files + ícones do tema do sistema + light mode + redesign Falcão System Design + seletor de logo customizada + **worktree discovery** (`.claude/worktrees/*`) + **scanner de portas do sistema** (cyan EXT chip pra processos rodando fora do launcher) + **pseudo-monorepos** (parent sem package.json + filhos com) + **toggle grid/list view** + **settings menu refinado** + **Claude Code awareness** (chip indigo ativo/histórico, drawer com tabs Logs/Claude, chart Recharts de tokens com toggle dia/mês/ano, lista de sessões com aiTitle + cost equivalente, spawn Claude here) + **VM Monitor** (Postgres+TimescaleDB na Hetzner, agente Rust 24/7, dashboard Recharts) + **Health checks externos** (UptimeRobot caseiro via GH Actions cron) + **Vercel stacks** (frontend Vercel + backend container agregados via label `monitor.stack`, drawer dedicado, loading overlay com spinner+mensagens cíclicas+reticências animadas, engrenagem de preferências). Próximos prováveis: **modo análise** (gráficos expandidos com brush + sync entre charts + logs do período), **alertas + Telegram bot**, **web app PWA** pra celular, **monitor de custos multi-serviço** (Vercel/Supabase/GH Actions).
