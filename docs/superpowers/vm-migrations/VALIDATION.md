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
