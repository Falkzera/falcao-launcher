#!/usr/bin/env bash
# Deploya o binário do falcao-monitor-agent pra VM Hetzner.
# Uso: ./scripts/deploy-monitor-agent.sh

set -euo pipefail

VM_HOST="${VM_HOST:-falcao@162.55.217.189}"
BIN_NAME="falcao-monitor-agent"

cd "$(dirname "$0")/.."

echo ">>> Build release"
(cd src-tauri && cargo build --release -p monitor-agent --bin "$BIN_NAME")

BIN_PATH="src-tauri/target/release/$BIN_NAME"
[[ -f "$BIN_PATH" ]] || { echo "binary not found: $BIN_PATH"; exit 1; }

echo ">>> Upload pra /tmp na VM"
scp "$BIN_PATH" "$VM_HOST:/tmp/$BIN_NAME"

echo ">>> Mover pra /usr/local/bin (sudo)"
ssh "$VM_HOST" "sudo mv /tmp/$BIN_NAME /usr/local/bin/$BIN_NAME && sudo chmod +x /usr/local/bin/$BIN_NAME"

echo ">>> Restart systemd service (se já existir)"
ssh "$VM_HOST" "systemctl --user restart falcao-monitor-agent.service 2>/dev/null || echo '(service ainda não instalado, ok)'"

echo ">>> Versão deployada:"
ssh "$VM_HOST" "/usr/local/bin/$BIN_NAME --version 2>/dev/null || echo '(binário sem flag --version, mas deployou)'"

echo "✓ Deploy concluído"
