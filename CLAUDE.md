# falcao-launcher

App desktop em **Tauri 2 + React 19 + TypeScript** que lê `~/Projects/`, lista cada projeto como card num grid, e roda `pnpm run <script>` com supervisão de processo, captura de logs ao vivo, detecção de porta e abertura automática do browser. Repositório público: **https://github.com/Falkzera/falcao-launcher**.

> Já há uma skill viva em `~/.claude/skills/falcao-launcher/SKILL.md` com decisões arquiteturais, roadmap em fases, gotchas e diário de bordo. Prefira ler a skill antes de mexer aqui.

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

## Layout dos `.agent.md`

Cada pasta lógica do projeto tem um `.agent.md` explicando o que vive ali. Ler sempre que for editar a pasta — economiza descoberta:

| Pasta | Tópico |
|---|---|
| `./` (este `CLAUDE.md`) | overview do projeto |
| `public/` | assets servidos pelo Vite na raiz |
| `src/` | entrypoint React, App, tema |
| `src/assets/` | imagens importadas via JS |
| `src/components/` | componentes React reutilizáveis |
| `src/styles/` | variants Framer Motion compartilhadas |
| `src-tauri/` | tudo do shell nativo Tauri |
| `src-tauri/src/` | código Rust (commands, supervisor, scanner, config, ports, external, icon) |
| `src-tauri/capabilities/` | permissões dos plugins Tauri |
| `src-tauri/icons/` | ícones do bundle nativo |

## Estado conhecido

Roadmap completo (fases 1–5 + empacotamento + sub-projetos D/A/B) na skill. Features atuais: scan + run/stop/logs + detecção de porta + auto-open browser + favicons + busca + atalhos + auto-allocação de portas + override por projeto + esconder/adicionar projetos + abrir VSCode/Ghostty/Files + ícones do tema do sistema + light mode + redesign Falcão System Design + seletor de logo customizada + **worktree discovery** (`.claude/worktrees/*`) + **scanner de portas do sistema** (cyan EXT chip pra processos rodando fora do launcher) + **pseudo-monorepos** (parent sem package.json + filhos com) + **toggle grid/list view** + **settings menu refinado** + **Claude Code awareness** (chip indigo ativo/histórico, drawer com tabs Logs/Claude, chart Recharts de tokens com toggle dia/mês/ano, lista de sessões com aiTitle + cost equivalente, spawn Claude here). Próximos prováveis: **tray icon GNOME**, **dashboard de observabilidade** (CPU/RAM/build time), suporte a Python/Go (detectar `pyproject.toml`/`go.mod`), override de script preferido por projeto.
