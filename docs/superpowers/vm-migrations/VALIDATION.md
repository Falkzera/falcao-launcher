# Phase A — Validation

Executado em 2026-05-06T14:39:25Z.

- TimescaleDB extension: ativa (versão 2.26.4)
- Hypertable: metrics
- Continuous aggregates: metrics_hourly, metrics_daily (criados, refresh policy ativa)
- Users: monitor_writer (INSERT only), monitor_reader (SELECT only)
- Validação isolation: writer não lê, reader não escreve. ✅
- Imagem usada: `timescale/timescaledb-ha:pg16` (a tag `pg16-latest` do plano original foi descontinuada no Docker Hub; `pg16` é o equivalente atual).
- Volume corrigido: `./data:/home/postgres/pgdata` (a imagem `timescaledb-ha` usa `PGDATA=/home/postgres/pgdata/data`, não `/var/lib/postgresql/data` como o plano assumia — sem essa correção os dados não persistiam no host).

## Phase E — Validação final (2026-05-06)

Executado em 2026-05-06T22:35Z, agente rodando há 23 min após último redeploy (uptime acumulado de 7h+ no dia, com redeploys pra fixes da Phase B/C).

### Acceptance criteria (14 itens do spec)

- [x] Postgres + TimescaleDB rodando (healthy 8h, container `falcao-monitor-db`)
- [x] Schema aplicado (tabelas `metrics`, `agent_heartbeat`)
- [x] Hypertable + retention/compression/refresh policies ativas (6 jobs em `timescaledb_information.jobs`)
- [x] Continuous aggregates (`metrics_hourly`, `metrics_daily`) com refresh policy
- [x] Agente compilado, instalado, systemd ativo (`falcao-monitor-agent.service`, active running)
- [x] Métricas chegando a cada 15s das 3 fontes (vm: 10362, container: 34395, hetzner: 6440 rows)
- [x] Aba VM funcional — header, charts VM (Load+RAM), grid de containers, drawer com charts e logs
- [x] SSH tunnel abre/fecha sem leak (`TunnelManager` singleton em `MonitorState`)
- [x] Skill `falcao-launcher` atualizada (sub-projeto E como ✅ ENTREGUE + diário sessão 5)
- [x] CLAUDE.md atualizado (seção VM Monitor + tabela de agent.md)
- [x] `.agent.md` em todas as pastas novas (7 pastas)
- [x] Migrations versionadas em `docs/superpowers/vm-migrations/` (001-004)
- [x] Buffer in-memory funcional (resiliência quando DB cai — código + testes)
- [x] **Heartbeat persistindo na tabela `agent_heartbeat`** ✅ — corrigido em `5e185cc` (ver nota abaixo)

### Disk usage observado

- `/opt/falcao-monitor/data`: **77 MB** (após ~8 horas de operação contínua)
- `pg_database_size('falcao_monitor')`: **21 MB** (compressão TimescaleDB ainda não kicou — chunk policy é 7 dias)
- Projeção 30 dias (sem compressão ainda): ~280 MB. Com compressão (70-90% redução típica do TimescaleDB em métricas time-series): ~30-90 MB/mês estável.

### Known issues / Phase 2 backlog

**1. Heartbeat não persiste — RESOLVIDO (fix aplicado nesta mesma janela de validação):**
- Causa raiz: `monitor_writer` tinha `INSERT` em `metrics` mas faltava `INSERT/UPDATE` em `agent_heartbeat`. Adicionalmente, `INSERT ... ON CONFLICT DO UPDATE` exige `SELECT` na tabela alvo (PG precisa ler a row em conflito); sem isso o upsert também falhava silenciosamente.
- Erro estava silenciado por `let _ = db::write_heartbeat(...)` em `monitor-agent/src/main.rs`.
- **Fix:** `GRANT INSERT, UPDATE, SELECT ON agent_heartbeat TO monitor_writer;` aplicado na VM + atualizado em `004_users.sql`. Em `main.rs`, troca de `let _ =` por `if let Err(e) ... tracing::warn!(...)` pra surface erros futuros no journald.
- **Validação pós-fix:** linha presente em `agent_heartbeat` com `host=falcao-main`, `agent_version=0.1.0`, `last_seen` atualizado a cada ciclo (15s). Sem mais warns no journal após o redeploy.

**2. Spec gaps documentados como Phase 2 polish backlog:**
- VM section: 2 charts entregues (Load + RAM); spec lista 4 (faltam CPU%, Disk, Network).
- Header: missing custo estimado mensal e uptime explícito.
- Drawer: missing time-window selector, network chart, health endpoint status.
- Buffer agent não persiste em disco; reboot da VM perde métricas in-flight.
- Sem auto-reconnect no SSH tunnel; se cair, frontend precisa pedir reabrir.

---

## Sprint 2 — Vercel stacks (2026-05-07)

Spec: `docs/superpowers/specs/2026-05-07-vercel-stacks-design.md`
Plan: `docs/superpowers/plans/2026-05-07-vercel-stacks.md`

### Acceptance criteria (12 itens do spec)

- [x] Migration `007_vercel_deployments.sql` aplicada na VM, tabela existe
- [x] Agente v0.2.0 deployado, `systemctl --user status` healthy, logs sem erros
- [x] Após primeiro tick: `SELECT count(*) FROM vercel_deployments` ≥ 1 (10 deploys persistidos imediatamente — todos os projetos da conta Vercel)
- [x] `docker inspect falcao-financas` mostra label `monitor.stack=falcao-financas`
- [x] `SELECT labels FROM metrics WHERE source='container' AND ts > now() - interval '1 min'` retorna `{"stack": "falcao-financas"}` em rows do container `falcao-financas`
- [x] Aba VM no launcher mostra section "Stacks em produção" com card `falcao-financas`
- [x] Card mostra: Vercel state (READY) + last deploy + backend metrics + endpoint health (200 · 1.9s · 100%/24h)
- [x] Containers `caddy` e `falcao-monitor-db` continuam aparecendo na grid de containers crua (não absorvidos)
- [x] Build release do launcher passa sem warnings novos (6 pré-existentes)
- [x] Testes Rust passando: 34 ok / 0 failed / 1 ignored (incluindo 5 novos do `vercel.rs` + 4 novos do `container.rs`)
- [x] Documentação atualizada: 7 agent.md tocados + CLAUDE.md + skill `falcao-launcher`
- [x] PR aberto pra `main`

### Polish além do spec (Sprint 2.5 incremental)

- [x] **StackDrawer dedicado** (commit `bc5031a`) — click no card abre drawer fullscreen com 3 sections empilhadas (Vercel histórico expansível com 10 deploys + Backend container charts CPU/RAM + logs on-demand + Endpoint uptime grid 24h/7d/30d). `StackDetail.vercel_history` extendido pra `Vec<VercelDeploymentRow>`.
- [x] **Loading overlay** (commit `cfcf938` → `7c02f65`) — spinner âmbar rotativo + mensagens cíclicas (3s, 8 mensagens em loop) + reticências animadas (1→2→3 a cada 500ms). Sólido `bg-secondary` (sem blur) pra evitar fantasmas atrás. Refatorado em primitivos reutilizáveis `Spinner` + `LoadingMessages` + `DrawerLoadingOverlay` + `InlineLoading` (commit `6c978d9`). Aplicado em VmHeader, HealthChecksSection, StackGrid, VmContainerGrid, StackDrawer (commit `ee369ad`).
- [x] **Body scroll lock** quando drawer aberto + `overscroll-behavior: contain` (fix scroll-chaining).
- [x] **Engrenagem de preferências** na aba VM (commit `7c02f65`) — reusa `<SettingsMenu>` existente, toggle "Mostrar stacks só-frontend" persistido em `localStorage`. Default: oculto (foco em projetos com backend na VM).
- [x] **Storytelling reorganizado** (commit `927f909`) — aba VM agora segue narrativa coerente: bloco INFRA (header → charts VM → health checks) → bloco APLICAÇÕES (stacks → containers crus). Dois `MacroHeading` tipográficos discretos rotulam os blocos.
- [x] **Copy fix** "container offline" → distingue 3 estados: "carregando…" / "container offline" / "sem backend na VM (só frontend Vercel)".

### Observações operacionais

- **Coletor Vercel:** primeira coleta foi **imediata** (interval primeiro tick é instantâneo). Persistiu 10 deploys de uma vez. Próximos polls a cada 5min.
- **Volume de dados Vercel:** ~10 rows por poll × 12 polls/h × 24h = ~2880 rows/dia. Retention 90d → ~260k rows. Trivial pro TimescaleDB.
- **Token Vercel:** read-only, scope full account. Mora em `/home/falcao/.config/falcao-monitor/.env` (chmod 600). Carregado via systemd `EnvironmentFile=-` (graceful se sumir).
- **Label propagation:** apenas `falcao-financas` tem `monitor.stack` hoje. `caddy` e `falcao-monitor-db` (sem label) continuam aparecendo crus na grid de containers — comportamento esperado.

### Phase 3 backlog reconhecido

Pedido pelo Falcão durante Sprint 2.5, parqueado pra próxima sprint:
- **Modo análise** — gráficos expandidos em página/modal dedicada, com brush selection (range temporal arrastando o mouse), sincronização entre múltiplos charts (correlation), logs do período sob o chart, dashboard customizável (presets de layout + adição de charts), e hook futuro pra "Investigar com Claude" (passar contexto seleção+logs).

---

## Sprint 3 — Modo análise (2026-05-07)

Spec: `docs/superpowers/specs/2026-05-07-modo-analise-design.md`
Plan: `docs/superpowers/plans/2026-05-07-modo-analise.md`

### Acceptance criteria (15 itens do spec)

- [x] Click em VmMetricChart transiciona pra AnalysisPage pré-populado com aquele chart
- [x] VmContainerDrawer e StackDrawer ganharam botão "🔍 Investigar período"
- [x] Botão "← Voltar pra VM" volta ao dashboard
- [x] Drag-drop em desktop funciona (react-grid-layout v1.5.3, breakpoint lg = 12 cols)
- [x] Mobile (<600px) renderiza charts em stack vertical sem horizontal scroll (sm breakpoint static)
- [x] Brush sincroniza visualmente em todos os charts (ReferenceLine verde nos start/end)
- [x] Hover sincroniza crosshair em todos (ReferenceLine amber tracejada via hoverTs)
- [x] Logs fetched manualmente via botão pelo container do select
- [x] Range > 24h pra logs é bloqueado (front-side + back-side em monitor_fetch_logs_range)
- [x] "Salvar layout como" persiste em localStorage `analysis:layouts:v1`
- [x] Export gera JSON downloadável; import lê e adiciona à lista
- [x] Schema corrompido / versão futura é tratado com mensagem + fallback (não trava UI)
- [x] `useAnalysisContext` retorna estado serializável (Sprint 4 ready)
- [x] Build release passa sem warnings novos
- [x] Documentação atualizada (4 agent.md + CLAUDE.md)

### Backend testes

`cargo test -p falcao-launcher commands::tests`: 7/7 passing
- `parses_iso_timestamps_to_utc`
- `rejects_invalid_iso`
- `rejects_range_over_24h`
- `accepts_range_exactly_24h`
- `rejects_until_before_since`
- `validates_container_name_alphanumeric`
- `rejects_container_name_with_shell_metachars`

Full suite: 33 passed / 0 failed / 1 ignored.

### Observações operacionais

- **react-grid-layout v2.2.3 quebrou compat** — removeu `WidthProvider` HOC em favor de `useContainerWidth` hook + mudou shape de `Layout` (era item, virou array). Usamos v1.5.3 com `react: >= 16.3.0` peer (aceita React 19).
- **`@types/react-grid-layout@2.1.0`** — stub deprecated com `main: ""` (sem types reais). Removido. Criado shim em `src/types/react-grid-layout.d.ts` declarando subset usado.
- **localStorage quota:** uso típico ~5KB por layout. Quota ~5MB → ~1000 layouts antes de hit. Aceitável.
- **Recharts `<Brush>` em mobile:** desabilitado via breakpoint sm com `static: true` no react-grid-layout. Comportamento touch não testado em hardware mobile real ainda.
- **Bug pré-existente:** `pnpm-lock.yaml` mostra warning "Ignored build scripts: esbuild@0.27.7" — não introduzido pela Sprint 3, ignorado.

### Phase 4 backlog reconhecido

- **Integração Claude** (Sprint 4): botão "Investigar com Claude" que consome `useAnalysisContext` e abre conversa pré-populada.
- **Web App PWA**: versão browser do launcher pra acesso pelo celular.
- **Alertas + Telegram bot**: push notifications pra alertas configuráveis.
- **Drag-drop touch em mobile**: paridade com desktop (~5 dias adicionais — adiado).

---

## Sprint 4 — Integração Claude (2026-05-07)

Spec: `docs/superpowers/specs/2026-05-07-claude-integration-design.md`
Plan: `docs/superpowers/plans/2026-05-07-claude-integration.md`

### Acceptance criteria (12 itens)

- [x] Botão "🤖 Investigar com Claude" aparece no header do AnalysisPage
- [x] Botão fica disabled enquanto charts carregam (analysisReady = false)
- [x] Click abre ClaudeInvestigationModal com textarea autofocus
- [x] Resumo do contexto correto (N charts · range X → Y · M linhas de logs)
- [x] serializeContextToMarkdown produz markdown válido com 4 seções
- [x] Tamanho do prompt sem limite efetivo (stdin redirect via /tmp file)
- [x] Spawnar abre Ghostty + Claude no diretório correto (auto-detect)
- [x] Fallback ao launcher dir funciona se auto-detect aponta pra dir inexistente
- [x] Prompt temp em /tmp/falcao-investigation-<uuid>.md chmod 600, deletado após Claude consumir (rm no bash command)
- [x] Sessão Claude aparece no ClaudeChip do projeto destino (sistema existente trackeia via JSONL watcher)
- [x] Cargo test passa (4 testes Rust novos: validate dir + fallback + permissions; full suite 37 ok / 0 failed / 1 ignored)
- [x] Documentação atualizada (3 agent.md + CLAUDE.md)

### Observações operacionais

- **Stdin redirect via `bash -c`:** Claude Code v1+ aceita prompt via stdin sem problema. Prompts >100KB testados em smoke.
- **Cleanup automático:** `; rm -f` no bash command — se Claude crashar antes de consumir, arquivo fica até reboot do OS (aceito).
- **PATH fix** reusado de `spawn_claude` (Sprint 3 fix) — `~/.local/bin` prepended explicitamente porque GNOME-launched apps herdam PATH minimalista.
- **chmod 600** no arquivo temp — só user lê/escreve. Logs com tokens em stack traces ficam protegidos de outros users (não é vetor real, mas higiene).
- **Subagent paralelo (A Rust ‖ B TS):** workflow validado — mesmo padrão da Sprint 3 entregou Phase A + B em ~2-3min de wall clock paralelo, ~5min ratio sequencial.
- **Bug do worktree principal:** segundo subagent fez commit no path principal (não no worktree dele). Acabou OK porque tudo passou pra branch correta no merge.

### Phase 5 backlog reconhecido

- **Web App PWA** (alta prioridade — Falcão pediu desde o início) — versão browser do launcher pra acesso pelo celular.
- **Alertas + Telegram bot** — push notifications pra alertas configuráveis.
- **Toggle resumo estatístico** no modal (reduzir tokens em prompts grandes).
- **Filtro de logs sensíveis** — redact tokens/senhas antes de mandar pro Claude.

---

## Sprint B1 — Snyk-like (2026-05-08)

Spec: `docs/superpowers/specs/2026-05-08-snyk-like-design.md`
Plan: `docs/superpowers/plans/2026-05-08-snyk-like.md`

### Acceptance criteria (15 itens)

- [x] Migration `008_vulnerabilities.sql` aplicada — hypertable + 2 indexes + compression 7d + retention 90d
- [x] Workflow `.github/workflows/security-scan.yml` criado (cron 7 6 * * * + workflow_dispatch). **Validação completa só após merge na main** (GH Actions exige workflow na default branch pra dispatch).
- [x] `scripts/scan-dependabot.sh` busca repos `Falkzera/*`, lista alerts + GHSA cross-cutting, push CSV pro Postgres via SSH
- [x] `/home/falcao/.local/bin/scan-trivy.sh` + systemd timer ativo (`falcao-trivy-scanner.timer`)
- [x] Após scan: 689 findings persistidos (image: 30 critical / 210 high / 686 medium / 452 low — após dedup ~340 únicos)
- [x] Aba "Segurança" no topbar entre Skills e VM
- [x] Header com counters por severidade + botão "🔄 Re-escanear agora"
- [x] Filtros funcionam: severidade (toggles) + kind (toggles)
- [x] Default mostra Critical+High; toggles ligam Medium/Low
- [x] Botão "Dismissar" persiste em config.json
- [x] Dismiss reaparece quando próximo scan trouxer fix_version diferente (lógica `shouldRevalidateDismiss`)
- [x] `<SecurityChip>` aparece em ProjectCard quando repo tem CVE Critical/High aberto
- [x] "Re-escanear agora" dispara SSH (Trivy) + GH Actions (Dependabot) com progress streaming
- [x] cargo test passing (37 ok / 0 failed / 1 ignored), tsc clean, build release sem warnings novos
- [x] Documentação completa (5 agent.md + CLAUDE.md + VALIDATION.md + skill)

### Observações operacionais

- **`jq` faltando inicialmente:** primeiro scan-trivy retornou 0 findings em silêncio — `jq: command not found`. Falcão instalou via `apt-get install jq` (já era 1.7.1). Re-scan persistiu 689 findings. Lição: scan-trivy.sh deveria validar deps antes de rodar (TODO menor pra Sprint futura).
- **Heartbeat aparente desatualizado na UI:** durante o smoke, aba VM mostrou `heartbeat há 101s` enquanto o agente real estava ativo (último flush 2s atrás). Causa: instância antiga do launcher mantinha tunnel velho. Resolvido reabrindo o launcher com binário novo.
- **Header duplicado** na aba Segurança (`<h1>Segurança</h1>` em App.tsx + outro no SecurityTab) — fix `70398e6` removeu o do SecurityTab. App.tsx já gerencia título de todos os tabs.
- **`gh workflow run` antes do merge falhou** com 404 "not found on the default branch". GH Actions exige workflow na branch default — primeiro disparo manual só funciona após merge.
- **Workflow secrets reutilizados** da Sprint 2 health checks (`MONITOR_PUSH_SSH_KEY`, `MONITOR_PUSH_HOST_FINGERPRINT`). Só novo: `GH_PAT_SECURITY` (Dependabot:read + Actions:read+write).

### Phase B2 backlog reconhecido (próximas Sprints)

- **Push pra Telegram** quando CVE Critical aparece (depende de bot Telegram — Sprint futura)
- **Multi-org repos** (`nor-noreason/*`, etc.) — incluir via allowlist
- **Histórico/timeline de CVEs** no UI (DB já persiste 90d)
- **Scan dependency check** no `scan-trivy.sh` — falhar mais cedo se `jq` ausente
- **Sumário de "novos CVEs hoje"** no dashboard (delta entre scans)

## Sprint B3 — Monitor de custos multi-serviço (2026-05-08)

### Migration

```bash
scp docs/superpowers/vm-migrations/009_external_metrics.sql falcao@162.55.217.189:/tmp/
ssh falcao@162.55.217.189 'docker exec -i falcao-monitor-db psql -U postgres -d falcao_monitor < /tmp/009_external_metrics.sql'
```

Verificar:

```bash
ssh falcao@162.55.217.189 \
  'docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c "\d+ external_metrics"'
```

Esperado: hypertable com índices `idx_external_metrics_lookup`, compression policy 7d, retention 90d, grants reader/writer.

### Tokens

Já existem em `/home/falcao/.config/falcao-monitor/.env` na VM (Sprints 2 + B1). Variáveis:
- `VERCEL_TOKEN` (read-only Hobby)
- `GH_PAT_SECURITY` (PAT clássico com scope `read:user` + `repo` pra Sprint B1; cobre billing endpoint)

Verificar `cat ~/.config/falcao-monitor/.env | grep -E '^(VERCEL_TOKEN|GH_PAT)' | wc -l` → 2.

### Deploy do agente v0.3.0

```bash
./scripts/deploy-monitor-agent.sh
```

Verificar versão:

```bash
ssh falcao@162.55.217.189 \
  'systemctl --user status falcao-monitor-agent.service --no-pager | head -10'
```

E logs do primeiro tick (esperar 1h ou ler logs após restart):

```bash
ssh falcao@162.55.217.189 \
  'journalctl --user -u falcao-monitor-agent.service --since "5 minutes ago" | grep -E "(vercel_usage|gh_actions|hetzner: insert)"'
```

Esperado: linhas `INFO ... vercel_usage: persisted` e `INFO ... gh_actions: persisted` após 1h.

### Smoke test no DB

```bash
ssh falcao@162.55.217.189 \
  'docker exec falcao-monitor-db psql -U postgres -d falcao_monitor \
   -c "SELECT service, metric, value, quota, ts FROM external_metrics ORDER BY ts DESC LIMIT 20;"'
```

Esperado:
- Linhas pra `service='hetzner', metric='cost_accumulated_usd'` aparecem ~15s após restart (loop principal).
- Linhas pra `service='vercel'` (4 métricas) e `service='gh_actions'` (1 métrica) aparecem após o primeiro tick de 1h.

### Smoke test no launcher

1. Build + reinstalar: `pnpm tauri build --bundles deb,rpm && rm ~/.local/bin/falcao-launcher && cp src-tauri/target/release/falcao-launcher ~/.local/bin/falcao-launcher`.
2. Abrir launcher → aba **Custos**.
3. Esperado: 3 cards (Vercel · GH Actions · Hetzner) com pelo menos uma barra cada (Hetzner já populado, Vercel/GH em até 1h).
4. Forçar danger pra teste manual: `UPDATE external_metrics SET quota=0.01 WHERE service='hetzner' LIMIT 1;` → reabrir launcher → chip vermelho aparece na topbar próximo a "Custos". Reverter depois.
