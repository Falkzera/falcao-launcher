# falcao-launcher

App desktop em **Tauri 2 + React 19 + TypeScript** que lê `~/Projects/`, lista cada projeto como card num grid, e roda `pnpm run <script>` com supervisão de processo, captura de logs ao vivo, detecção de porta e abertura automática do browser.

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

O **app já está instalado** no GNOME — abrir via Activities → "Falcão Launcher" (binário em `~/.local/bin/falcao-launcher`).

## Stack

- **Frontend**: Vite 7, React 19, TypeScript 5.8, Tailwind v4 (sem `tailwind.config.js` — tema em `src/App.css` via `@theme {}`)
- **Backend**: Rust (edition 2021), Tauri 2.10, tokio (process/io-util/sync)
- **Identifier**: `com.falcao.launcher`
- **Package manager**: pnpm

## Arquitetura em uma frase

`scan_projects` lê `~/Projects` no Rust, frontend renderiza grid; `start_project` spawna `pnpm run <script>` com `process_group(0)` (matar árvore inteira), supervisor task com `tokio::select!` lê stdout/stderr, regex extrai porta, eventos `log` / `status` / `port` chegam no React via `listen()`, drawer lateral mostra logs.

## Convenções importantes

- **Não escrever Rust complexo sem alinhar com o Falcão.** Ele é copiloto, não conduz Rust. Explicar conceitos novos com 1-2 frases.
- **Tudo em PT-BR** com o Falcão.
- **Mexer em `src-tauri/src/process.rs` é sensível** — mexer com supervisor de processos pode deixar processos zumbis. Ao alterar lifecycle (start/stop/wait), rodar `cargo test` antes de claim-ar como pronto.
- **Tailwind v4 não tem `tailwind.config.js`.** Cores e fontes ficam em `src/App.css` no bloco `@theme {}`. Vars CSS são consumidas como `var(--color-accent)` ou classes `bg-[var(--color-accent)]`.
- **Tauri serializa structs em snake_case por padrão.** Tipos TS devem casar (`detected_script`, não `detectedScript`). Args de comandos do JS pra Rust SÃO auto-convertidos camelCase ↔ snake_case (mas payloads de eventos não são).
- **Ícones embedam em build-time** (`generate_context!()`). Trocar arquivos em `src-tauri/icons/` exige `touch src-tauri/src/lib.rs` pra forçar recompile.

## Layout dos `.agent.md`

Cada pasta lógica do projeto tem um `.agent.md` explicando o que vive ali. Ler sempre que for editar a pasta — economiza descoberta:

| Pasta | Tópico |
|---|---|
| `./` (este `CLAUDE.md`) | overview do projeto |
| `public/` | assets servidos pelo Vite na raiz |
| `src/` | entrypoint React, App, tema |
| `src/assets/` | imagens importadas via JS |
| `src/components/` | componentes React reutilizáveis |
| `src-tauri/` | tudo do shell nativo Tauri |
| `src-tauri/src/` | código Rust (commands, supervisor, scanner) |
| `src-tauri/capabilities/` | permissões dos plugins Tauri |
| `src-tauri/icons/` | ícones do bundle nativo |

## Estado conhecido

Roadmap completo (fases 1–4 + empacotamento) na skill. Próximos prováveis: tray icon, persistência de overrides de script por projeto, suporte a Python/Go (detectar `pyproject.toml`/`go.mod`).
