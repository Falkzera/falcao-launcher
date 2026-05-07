# VM Monitor — Recap da Sessão 2026-05-06

> Sessão maratona única que entregou o **VM Monitor** end-to-end no `falcao-launcher`: do brainstorming até feature completa em produção rodando 24/7. Documento de fechamento pra retomar contexto rapidamente em sessões futuras.

## Resumo executivo

| Métrica | Valor |
|---|---|
| **Sessões consecutivas** | 1 (longa, dia inteiro) |
| **PRs mergeados em main** | 9 |
| **Commits em produção** | ~50 (somando todos os PRs) |
| **Linhas de código novas** | ~2.500 (Rust + TS + SQL + Bash + YAML) |
| **Skills atualizadas** | 3 (`falcao-launcher`, `falcao-hetzner`, `falcao-default`) |
| **Specs/plans/recaps escritos** | 4 (~3.500 linhas de doc estruturada) |
| **Custo recurring adicional** | $0 (tudo no free tier de cada serviço) |
| **Bugs encontrados em produção** | 5 (todos corrigidos no mesmo dia) |

## O que foi entregue

### Phase 1 — VM Monitor base (PR #1)

Fundação: coletor 24/7 + dashboard real-time.

- **Postgres+TimescaleDB** rodando em `/opt/falcao-monitor/` na VM Hetzner (porta 5432 local-only, retention 35d, compression 7d, continuous aggregates hourly+daily)
- **Agente Rust** (`monitor-agent` v0.1.x) em systemd user service, poll a cada 15s, buffer in-memory pra resiliência
- **3 coletores**: VM (`/proc/*` + `df`), containers (`docker stats` + `docker inspect`), Hetzner (`hcloud server describe`)
- **SSH tunnel** via `ssh -L` (não `russh`) abre on-demand quando aba VM é aberta
- **Aba "VM"** no launcher com header de status, charts Recharts, grid de containers, drawer de detalhes com logs on-demand

### Hardening + UX iniciais (PRs #2, #3)

- `MONITOR_READER_PASSWORD` fallback de `~/.config/falcao-launcher/.env` quando env var ausente (Super+F lança sem env)
- **Bug crítico do CPU%**: medição em paralelo com `tokio::join!` via `docker stats`/`hcloud` corrompia delta de `/proc/stat` (reportava 78-85% real era 5%). Fix: state-across-iterations entre ticks do agent loop em vez de in-call sleep

### Phase 2 Polish (PR #4) — A+B+C+D em uma sprint

Time multi-papel: CTO + Backend + Frontend + QA + Cybersec.

- **A (limites visíveis)**: componente `UsageBar` reutilizável com thresholds verde/amarelo/vermelho. Aplicado em VmHeader (RAM/Disco/Bandwidth) e cards de container.
- **B (time-window selector)**: 1h/6h/24h/7d/30d, helper `windowToParams` mapeia bucket TimescaleDB apropriado.
- **C (network rate)**: helper `toRate()` deriva MB/s do counter cumulativo no frontend (decisão CTO: não muda agente).
- **D (custo Hetzner)**: agente bumpou pra v0.1.1 emitindo `cost_accumulated_usd` + `vm_age_hours` (constante `HOURLY_RATE_USD = 0.00766`). Card "Custo" no header com forecast mensal.

### Sprint 2 — External Health Checks (PR #5)

UptimeRobot caseiro do zero.

- **Migrations 005+006**: tabela `health_checks` (hypertable + CAs hourly/daily + grants writer/reader)
- **`apply-vm-migrations.sh`**: script idempotente com tabela `schema_migrations` pra tracking
- **GitHub Actions cron**: `*/5min` (ajustado depois pra `2-59/5`) probeia 3 endpoints em paralelo via `curl`, push pra Postgres da VM via SSH
- **SSH key dedicada `falcao-monitor-push`**: `command="docker exec ... psql ..."` + `no-port-forwarding` + `no-pty` + `no-X11/agent-forwarding` no authorized_keys
- **Section nova "Health checks externos"** entre VmHeader e charts: `<HealthCheckRow>` com status dot, latência colorida, 3 uptime pills (24h/7d/30d) por endpoint

### Bugfixes pós-deploy (PRs #6, #7, #8, #9)

Todos descobertos em uso real:

- **#6** — VmTab desmontava ao trocar de aba (Skills↔VM); fix: render sempre, hide via CSS
- **#7** — Pool size 2 era subdimensionado pro fan-out de 12 acquisitions concurrent + UI não exibia erros
- **#8** — `avg(numeric)` no Postgres panicava ao deserializar pra `f64` no Rust; fix: cast `::float8` explícito
- **#9** — Cron `*/5` pegava peak hours do GH Actions; fix: `2-59/5` desloca pra minutos ímpares

## Arquitetura final em produção

```
┌──────────────────────────────────────────────────────────────────────┐
│                    GitHub Actions (free tier)                        │
│                                                                      │
│   Workflow "External Health Checks"                                  │
│   cron: 2-59/5 * * * *  +  workflow_dispatch                         │
│         │                                                            │
│         ▼ 1. probe-endpoints.sh (curl paralelo, -k SÓ pro IP direto)│
│   CSV: ts, endpoint, status_code, response_ms, ok, error             │
│         │                                                            │
│         ▼ 2. push-health-results.sh                                  │
│   SSH key dedicada (command-restricted, host pinned)                 │
└──────────┬───────────────────────────────────────────────────────────┘
           │ \COPY via stdin
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  VM Hetzner (CX23, Nuremberg, 162.55.217.189)                       │
│                                                                      │
│  /opt/falcao-monitor/                                                │
│    ├─ docker-compose.yml  → falcao-monitor-db (timescaledb-ha:pg16) │
│    ├─ data/  (~80 MB acumulados em 24h)                              │
│    └─ migrations/  (5 SQL files versionados)                         │
│                                                                      │
│  Postgres em 127.0.0.1:5432 (NUNCA na internet)                     │
│    Roles: monitor_writer (INSERT), monitor_reader (SELECT)           │
│    Tables: metrics, agent_heartbeat, health_checks, schema_migrations│
│    CAs: metrics_hourly, metrics_daily, health_checks_hourly,         │
│         health_checks_daily                                          │
│                                                                      │
│  systemd user service: falcao-monitor-agent.service                  │
│    Binário Rust em /usr/local/bin/falcao-monitor-agent               │
│    Coleta a cada 15s: VM (12 metrics), containers (9), hetzner (4)  │
│    Buffer in-memory + retry exponential backoff em DB falhar         │
└──────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ SSH tunnel on-demand
                                  │ (ssh -L 54322:localhost:5432)
                                  │ tokio-postgres pool max_size=8
                                  │ apenas monitor_reader (SELECT only)
                                  │
┌──────────────────────────────────────────────────────────────────────┐
│  Máquina do Falcão (Arch + GNOME)                                    │
│                                                                      │
│  ~/.local/bin/falcao-launcher (Tauri 2 + React 19)                   │
│    ├─ Aba "Projetos" (existing)                                      │
│    ├─ Aba "Skills" (existing)                                        │
│    └─ Aba "VM" (NEW)                                                 │
│         ├─ Header: agent version + load + RAM% + custo + bars        │
│         ├─ Health Checks: 3 rows com status + uptime pills           │
│         ├─ VM geral: 5 charts (Load, RAM, CPU, Disco, Network rate) │
│         ├─ Time-window selector: 1h/6h/24h/7d/30d                    │
│         └─ Drawer por container: charts + logs on-demand             │
│                                                                      │
│  Configs:                                                            │
│    ~/.config/falcao-launcher/.env                                    │
│      MONITOR_READER_PASSWORD=...  (chmod 600)                        │
│    ~/.ssh/falcao-monitor-push  (chave SSH dedicada do CI)           │
└──────────────────────────────────────────────────────────────────────┘
```

## Lições aprendidas (técnicas — vale ouro pra próximas sessões)

### 1. Tipo `numeric` do Postgres NÃO converte pra `f64` automaticamente em tokio_postgres

`avg(integer)`, `avg(numeric)`, e literais decimais como `100.0` retornam `numeric` (arbitrary precision). `tokio_postgres::Row::get::<_, f64>` panica ao tentar deserializar — sem o crate `rust_decimal`.

**Fix sempre:** cast explícito `::float8` em queries que retornam pra `f64`. Vale também pra `SUM(int)` que é bigint→numeric. PR #8.

### 2. Panic em task `tokio::join!` vira **promise pendente eterna**, não rejeição

Quando uma task spawnada via `tokio::join!` panica, o Tauri runtime NÃO converte isso em reject da Promise no JS. A promise fica pending para sempre. UI fica em loading sem nunca mostrar erro.

**Defesa**: components devem surface `error` do hook, não só `data`. PR #7 + #8.

### 3. CPU% via delta requer state-across-iterations, não in-call sleep

Sleep de 100ms in-call enquanto outros coletores rodam concorrentemente faz a medição capturar o trabalho deles → reporta 80% quando real é 5%.

**Fix**: cada iteration salva o último `/proc/stat` no `VmCollectorState`, próxima iteration calcula delta vs anterior (~15s window, livre de interferência). PR #3.

### 4. GH Actions cron atrasa nos minutos cheios (peak load)

Doc oficial avisa, mas é fácil esquecer. `*/5 * * * *` pega `:00, :05, :10...` que são peak. Trocar pra `2-59/5 * * * *` resolve. PR #9.

### 5. Pool size pequeno + fan-out concorrente = hang silencioso

Pool max_size=2 com `tokio::join!` de 3 tasks que cada uma faz 4 queries seriais = 12 acquisitions com slot de 2. Pode hang se há contention com outros polling. Bumpou pra 8. PR #7.

### 6. Squash merges divergem hash entre branches longevas

`development → main` via squash cria commit novo em main com hash ≠ do que ficou em development. Próxima feature → conflito add/add silencioso.

**Mitigação**: depois de cada `release` PR, fazer resync local de development (`git merge origin/main --no-edit`, resolver com `--ours`). Documentado em `falcao-default` skill.

### 7. SSH `command="..."` restriction realmente trava o remote

Testado: `ssh -i key -L ...` com `no-port-forwarding` falha. `ssh -i key "echo BREACH"` com `command="psql ..."` ignora o "echo" e chama psql. Cybersec validou em produção.

### 8. Migrations Postgres init-script NÃO interpolam env vars

Files em `/docker-entrypoint-initdb.d/*.sql` rodam via `psql -f` sem expansão. `${VAR}` literal vira string `"${VAR}"`. Pra placeholder se manter, precisa renderizar via `envsubst` antes (Phase A).

### 9. `pkill -f "padrão"` pode matar a si mesmo

`pkill -f "falcao-launcher"` matou o shell wrapper que tinha "falcao-launcher" no path. Sempre usar padrão estrito (`/.local/bin/falcao-launcher$`) ou `pgrep` + `kill` por PID.

### 10. Continuous aggregates do TimescaleDB têm refresh policy schedule

`metrics_hourly` refresh a cada 15min, `metrics_daily` a cada 1h. Dashboards consultando CAs vêem dados com até 15min de defasagem. Para "now", queries direto na hypertable raw.

## Pendências reconhecidas (não-bloqueantes)

| Item | Onde | Defer porque |
|---|---|---|
| `--color-warning` token colide com `--color-accent-primary` (ambos amber) | `src/App.css` | Workaround `#eab308` inline funciona; fix definitivo pede mudança no design system |
| 13 clippy warnings pré-existentes em launcher lib | `claude.rs`, `process.rs`, etc. | Outras features, não as nossas. Faxina separada |
| Wrapper script `/usr/local/bin/falcao-monitor-push` pra remover `PGPASSWORD` do `authorized_keys` | VM | Cybersec recomendou follow-up; acceptable pra Phase 1 (mesmo nivel de proteção do `.env`) |
| Header `Uptime: X dias` explícito | `VmHeader` | Spec gap menor, dado já vem em `vm_age_hours` |
| Network chart per-container no drawer | `VmContainerDrawer` | Nice-to-have |
| SHA-pin do `actions/checkout@v4` | Workflow | Cosmético |

## Phase 3 backlog (próximas sessões)

Cada item merece **brainstorm + spec + plan próprios** quando for atacado.

### 🔥 Anomaly detection com ML

- Modelo simples (Isolation Forest ou estatística rolling) treinado com dados sintéticos + simulações de DDoS
- Roda como container separado na VM ou como módulo do agente
- Detecta desvios em métricas sem regra explícita
- Sugestão pra começar: limiar estatístico (média móvel ± 3σ), depois evoluir pra ML

### 📱 Push pro celular via Web App PWA

- Web app deployado na Vercel reusa frontend React do launcher
- PWA instalável no celular
- Web Push API pra notificações
- Backend HTTP autenticado em `monitor.duckdns.org` (novo subdomínio + Caddy route)
- Auth: token estático via Falcão (single-user)

### 🚨 Alertas predefinidos

- Set hardcoded de regras (CPU >80% por 5min, endpoint down, custo > forecast +20%, etc.)
- Telegram bot envia push (mais simples que Web Push pra começar)
- Histórico de alerts em tabela `alerts`
- UI no launcher mostra alerts ativos + log

### 🛡️ DDoS detection

- Combina spike de network rate + queda de uptime + spike de error rate
- Pode usar dados que já temos coletando
- Trigger de alerta + log
- Bonus: integração com Cloudflare se decidir botar na frente

### 🌐 Web app (versão browser do dashboard)

- Versão Vercel do mesmo dashboard
- Backend HTTP API em vez de SSH tunnel
- Falcão acessa de qualquer dispositivo
- Sobreposição funcional com PWA — pode ser a MESMA coisa

### 💰 Monitor de custos multi-serviço (escopo original do sub-projeto E)

- Vercel: bandwidth, build minutes
- Supabase: DB usage, bandwidth
- GitHub Actions: minutos consumidos
- Hetzner: já temos
- Tabela `external_metrics` agrega tudo
- Charts comparativos cross-service

## Estado operacional atual (commitar)

### Comandos pra ressumir tudo rápido

```bash
# Status da VM
falcao-vps-status                # se /home/falcao/scripts/ estiver no PATH

# Status do agente
ssh falcao@162.55.217.189 "systemctl --user status falcao-monitor-agent.service --no-pager | head -5"

# Métricas chegando
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT source, count(*), max(ts) AS last FROM metrics GROUP BY source;\""

# Health checks chegando
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT endpoint, count(*), max(ts) AS last FROM health_checks GROUP BY endpoint;\""

# Workflow runs
gh run list --workflow=health-checks.yml --limit 5

# Trigger manual
gh workflow run health-checks.yml

# Recompilar launcher
cd ~/Projects/falcao-launcher && pnpm tauri build --bundles deb,rpm
rm -f ~/.local/bin/falcao-launcher && cp src-tauri/target/release/falcao-launcher ~/.local/bin/

# Deploy do agente
cd ~/Projects/falcao-launcher && ./scripts/deploy-monitor-agent.sh

# Aplicar nova migration
cd ~/Projects/falcao-launcher && ./scripts/apply-vm-migrations.sh --dry-run
cd ~/Projects/falcao-launcher && ./scripts/apply-vm-migrations.sh
```

### Custo total mensal

| Item | Custo |
|---|---|
| VM Hetzner CX23 + IPv4 | ~$5,59/mês |
| Vercel free tier | $0 |
| Supabase free tier | $0 |
| GitHub Actions | $0 (uso ~60min/mês de 2000 free) |
| DuckDNS | $0 |
| **Total** | **~$5,59/mês (~R$30-35)** |

### Arquivos de referência

- **Spec original**: `docs/superpowers/specs/2026-05-06-vm-monitor-fase-1-design.md`
- **Plan executado**: `docs/superpowers/plans/2026-05-06-vm-monitor-fase-1.md`
- **Validation log**: `docs/superpowers/vm-migrations/VALIDATION.md`
- **Checkpoint**: `docs/superpowers/CHECKPOINT-vm-monitor.md`
- **Skill principal**: `~/.claude/skills/falcao-launcher/SKILL.md` (sub-projeto E)
- **Skill infra**: `~/.claude/skills/falcao-hetzner/SKILL.md` (seção "VM Monitor stack")
- **Skill workflow**: `~/.claude/skills/falcao-default/SKILL.md`
- **Migrations versionadas**: `docs/superpowers/vm-migrations/00{1..6}_*.sql`

## Reflexão sobre o método

A sessão validou um **padrão de execução multi-papel** que vale a pena formalizar:

1. **Brainstorm guiado** com perguntas direcionadas (granularidade, frequência, host placement, schema strategy)
2. **Spec doc** versionado em `docs/superpowers/specs/`
3. **Plan detalhado** com tasks bite-sized em `docs/superpowers/plans/`
4. **CTO subagent** quebra plan em work orders por papel
5. **Backend + Frontend em paralelo** quando arquitetura permite
6. **DevOps separado** quando há infra/scripts
7. **QA + Cybersec em paralelo** após implementação
8. **Controller (humano + Claude principal)** coordena merges + manual setup quando precisa
9. **Skills atualizadas** ao final pra próxima sessão ter contexto

**Anti-pattern descoberto**: dispatch task-by-task com 3 subagents cada (implementer + 2 reviewers) quebra a sessão por contexto antes de terminar. Granularidade de phase com time multi-papel é mais sustentável.

**Próxima sessão**: começar lendo este arquivo + a skill `falcao-launcher` (Sub-projeto E) + decidir prioridade no Phase 3 backlog. Tudo já está no ar 24/7, então não há pressa — só roadmap.

---

**Status final em 2026-05-06:**

✅ VM Monitor entregue ponta a ponta
✅ 9 PRs mergeados
✅ Cron de health checks rodando
✅ Backend coletando 25+ métricas a cada 15s
✅ Custos mantidos em $5,59/mês
✅ Documentação completa pra retomar
🚧 Phase 3 backlog aguardando próxima sessão
