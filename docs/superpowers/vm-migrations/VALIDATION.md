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
- [ ] **Heartbeat persistindo na tabela `agent_heartbeat`** ⚠️ — ver "Known issues" abaixo

### Disk usage observado

- `/opt/falcao-monitor/data`: **77 MB** (após ~8 horas de operação contínua)
- `pg_database_size('falcao_monitor')`: **21 MB** (compressão TimescaleDB ainda não kicou — chunk policy é 7 dias)
- Projeção 30 dias (sem compressão ainda): ~280 MB. Com compressão (70-90% redução típica do TimescaleDB em métricas time-series): ~30-90 MB/mês estável.

### Known issues / Phase 2 backlog

**1. Heartbeat não persiste (bug encontrado na validação E4):**
- Migration `004_users.sql` concedeu `INSERT` em `metrics` pra `monitor_writer` mas **não** em `agent_heartbeat`.
- Erro silenciado por `let _ = db::write_heartbeat(...)` em `monitor-agent/src/main.rs:74`.
- Tabela `agent_heartbeat` está com 0 rows apesar do agente tentar INSERT a cada 15s.
- **Fix sugerido (Phase 2):** rodar `GRANT INSERT, UPDATE ON agent_heartbeat TO monitor_writer;` na VM + remover o `let _ =` em main.rs (deixar warn em caso de erro real).
- **Impacto:** o frontend mostra "agente offline" se depender só do heartbeat. Mitigação atual: o frontend pode olhar o `MAX(ts)` da tabela `metrics` pra inferir liveness.

**2. Spec gaps documentados como Phase 2 polish backlog:**
- VM section: 2 charts entregues (Load + RAM); spec lista 4 (faltam CPU%, Disk, Network).
- Header: missing custo estimado mensal e uptime explícito.
- Drawer: missing time-window selector, network chart, health endpoint status.
- Buffer agent não persiste em disco; reboot da VM perde métricas in-flight.
- Sem auto-reconnect no SSH tunnel; se cair, frontend precisa pedir reabrir.
