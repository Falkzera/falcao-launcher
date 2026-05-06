# VM Monitor — Checkpoint de execução

> Documento vivo do estado de execução do plano `2026-05-06-vm-monitor-fase-1.md`. Atualize ao terminar cada Phase. Serve pra retomar a execução em sessão futura sem perder contexto.

## Estado em 2026-05-06 (atual)

### Branch
`feature/vm-monitor-fase-1` (em `~/Projects/falcao-launcher/`)

### Phases
- ✅ **Phase A** — Postgres+TimescaleDB na VM (concluída + revisada)
- ✅ **Phase B** — Rust agent + systemd (concluída, agente rodando 24/7)
- ✅ **Phase C** — SSH tunnel + Tauri commands (concluída + security fixes)
- ✅ **Phase D** — Frontend (aba VM) — concluída (com spec gaps Phase 2 abaixo)
- ✅ **Phase E** — Docs + validação + PR — concluída

### Status final: PR #1 aberto, NÃO mergeado (Falcão decide)
https://github.com/Falkzera/falcao-launcher/pull/1

### Spec gaps marcados como Phase 2 backlog
- VM section só tem 2 charts (Load + RAM) — spec lista 4 (faltam CPU%, Disk, Network)
- Header sem custo estimado nem uptime explícito
- Drawer sem time-window selector (1h/6h/24h/7d/30d) — hardcoded 60min
- Drawer sem network chart, sem health endpoint status

### Bug crítico encontrado e corrigido durante validação
- **Heartbeat não persistia:** `monitor_writer` faltava SELECT/INSERT/UPDATE em `agent_heartbeat`. SELECT é necessário porque `INSERT ON CONFLICT DO UPDATE` lê a linha em conflito. Erro silenciado por `let _ = ...` no main loop. Fix em commit 5e185cc + GRANTs aplicados via runtime.

### Credenciais (NÃO COMMITAR)

Senhas armazenadas em `/opt/falcao-monitor/.env` na VM (chmod 600). Cópia local em `/tmp/falcao-monitor-pwds.env` (também 600, pode sumir em reboot).

```
PG_SUPER_PWD              = aYzErDAMbBrGqgV4QYxGZwjumsPSzb7D
MONITOR_WRITER_PASSWORD   = R9O1KCcpCpmklWXDlJ0QRSpU6I3CTPhL
MONITOR_READER_PASSWORD   = oMDl5KH5G4urHW58uMoOkE56cdXDQVPN
```

**MONITOR_READER_PASSWORD** é a que precisa ir pra Phase C como GitHub Secret/`.env.local` do launcher.

### Estado da VM
- Container: `falcao-monitor-db` healthy (TimescaleDB pg16, 7h+ uptime)
- Volume: `/opt/falcao-monitor/data/` (~50MB)
- systemd service: `falcao-monitor-agent.service` ativo (~7h uptime, ~1.4MB RAM)
- Métricas chegando: `vm`, `container`, `hetzner` sources — milhares de amostras

### Deviations já aplicadas (vs plano)
1. **Image tag:** `pg16-latest` não existe → `pg16`
2. **Volume mount:** `./data:/var/lib/postgresql/data` → `./data:/home/postgres/pgdata` (PGDATA real do `timescaledb-ha`)
3. **Postgres user pra teste de integração:** plan sugere `monitor_writer`, mas writer não pode SELECT — usar `postgres` super (senha `PG_SUPER_PWD`)

Estes ajustes vivem em `docs/superpowers/vm-migrations/VALIDATION.md`. Plano não foi reescrito — só o checkpoint nota.

### Reviews pendentes
- Phase B ainda não passou por spec review nem code quality review (Phase A passou).

### Como retomar

1. `cd ~/Projects/falcao-launcher && git checkout feature/vm-monitor-fase-1`
2. Validar ambiente:
   ```bash
   ssh falcao@162.55.217.189 "systemctl --user status falcao-monitor-agent.service --no-pager | head -5"
   ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c 'SELECT source, count(*), max(ts) FROM metrics GROUP BY source'"
   ```
3. Rodar spec/code reviews da Phase B (próximo passo)
4. Phase C — adicionar deps Tauri (russh, tokio-postgres) + módulo `monitor` em `src-tauri/src/`

## Histórico de checkpoints

- 2026-05-06 14:33: Phase A concluída + revisada (DONE)
- 2026-05-06 14:59: Phase B implementada (B1-B8 done, agente vivo)
- 2026-05-06 ~22:00: usuário pausou; doc atual escrito ao retomar
