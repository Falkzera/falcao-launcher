use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use uuid::Uuid;

fn validate_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_dir() {
        return Err(format!("invalid project path: {}", path));
    }
    Ok(p)
}

fn spawn_detached(cmd: &mut Command) -> Result<(), String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_child| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    let mut cmd = Command::new("code");
    cmd.arg(&p);
    spawn_detached(&mut cmd).map_err(|e| format!("falha ao abrir VSCode: {}", e))
}

#[tauri::command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    let mut cmd = Command::new("ghostty");
    cmd.arg(format!("--working-directory={}", p.display()));
    spawn_detached(&mut cmd).map_err(|e| format!("falha ao abrir Ghostty: {}", e))
}

#[tauri::command]
pub fn open_in_files(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    if Command::new("nautilus")
        .arg(p.as_os_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    let mut cmd = Command::new("xdg-open");
    cmd.arg(p.as_os_str());
    spawn_detached(&mut cmd).map_err(|e| format!("falha ao abrir gerenciador de arquivos: {}", e))
}

#[tauri::command]
pub fn kill_pid(pid: u32, force: Option<bool>) -> Result<(), String> {
    if pid == 0 || pid == 1 {
        return Err("pid inválido".into());
    }
    let signal = if force.unwrap_or(false) {
        libc::SIGKILL
    } else {
        libc::SIGTERM
    };
    let rc = unsafe { libc::kill(pid as i32, signal) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!("kill({}): {}", pid, err));
    }
    Ok(())
}

#[tauri::command]
pub fn spawn_claude(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    let mut cmd = Command::new("ghostty");
    cmd.arg(format!("--working-directory={}", p.display()))
        .arg("-e")
        .arg("claude");

    // App GNOME-launched herda PATH minimalista sem ~/.local/bin onde o claude
    // vive. Prependar explicitamente — env() preserva o resto do ambiente.
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin");
        let current_path = std::env::var("PATH")
            .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
        cmd.env("PATH", format!("{}:{}", local_bin.display(), current_path));
    }

    spawn_detached(&mut cmd).map_err(|e| format!("falha ao spawnar Claude: {}", e))
}

/// Valida que `target_dir` existe e é um diretório.
/// Se inválido, faz fallback pra `~/Projects/falcao-launcher` (sempre existe
/// pelo nosso ambiente). Retorna o caminho efetivo a usar.
fn validate_or_fallback_dir(target: &std::path::Path) -> PathBuf {
    if target.is_dir() {
        return target.to_path_buf();
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let fallback = home.join("Projects").join("falcao-launcher");
    eprintln!(
        "[spawn_claude_investigation] target_dir inválido ({:?}), usando fallback: {:?}",
        target, fallback
    );
    fallback
}

/// Escreve o prompt em /tmp/falcao-investigation-<uuid>.md com chmod 600
/// (só user lê/escreve). Retorna o path do arquivo gerado.
fn write_prompt_to_tmp(prompt: &str) -> Result<PathBuf, String> {
    let id = Uuid::new_v4();
    let path = std::env::temp_dir().join(format!("falcao-investigation-{}.md", id));

    let mut file = fs::File::create(&path)
        .map_err(|e| format!("não foi possível criar {:?}: {}", path, e))?;
    file.write_all(prompt.as_bytes())
        .map_err(|e| format!("não foi possível escrever em {:?}: {}", path, e))?;

    let mut perms = file.metadata().map_err(|e| e.to_string())?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(&path, perms)
        .map_err(|e| format!("não foi possível setar permissions: {}", e))?;

    Ok(path)
}

/// Spawna Claude Code numa janela Ghostty nova, com prompt pré-formatado
/// vindo do `AnalysisContext` do modo análise. Auto-fallback do diretório
/// se o destino sugerido pela UI não existir.
///
/// Fluxo:
///   1. Resolve target_dir (existe? senão fallback launcher dir)
///   2. Escreve prompt em /tmp/falcao-investigation-<uuid>.md (chmod 600)
///   3. Spawna ghostty fire-and-forget executando:
///        bash -c "claude < /tmp/<file>; rm -f /tmp/<file>"
///      (cleanup automático após Claude consumir o stdin)
///   4. Retorna ok — UI fecha modal
#[tauri::command]
pub fn spawn_claude_investigation(
    prompt_markdown: String,
    target_dir: String,
) -> Result<(), String> {
    let target = PathBuf::from(&target_dir);
    let effective_dir = validate_or_fallback_dir(&target);
    let prompt_path = write_prompt_to_tmp(&prompt_markdown)?;

    let bash_cmd = format!(
        "claude < {0:?}; rm -f {0:?}",
        prompt_path.display().to_string()
    );

    let mut cmd = Command::new("ghostty");
    cmd.arg(format!("--working-directory={}", effective_dir.display()))
        .arg("-e")
        .arg("bash")
        .arg("-c")
        .arg(&bash_cmd);

    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin");
        let current_path = std::env::var("PATH")
            .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
        cmd.env("PATH", format!("{}:{}", local_bin.display(), current_path));
    }

    spawn_detached(&mut cmd).map_err(|e| format!("falha ao spawnar Claude investigation: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_existing_directory_returns_same() {
        let result = validate_or_fallback_dir(&PathBuf::from("/tmp"));
        assert_eq!(result, PathBuf::from("/tmp"));
    }

    #[test]
    fn falls_back_when_target_missing() {
        let nonexistent = PathBuf::from("/tmp/this-path-does-not-exist-9zX");
        let result = validate_or_fallback_dir(&nonexistent);
        let home = dirs::home_dir().unwrap();
        assert_eq!(result, home.join("Projects").join("falcao-launcher"));
    }

    #[test]
    fn falls_back_when_target_is_file_not_dir() {
        let file_path = std::env::temp_dir().join("test-not-a-dir.txt");
        std::fs::write(&file_path, b"not a dir").unwrap();
        let result = validate_or_fallback_dir(&file_path);
        let home = dirs::home_dir().unwrap();
        assert_eq!(result, home.join("Projects").join("falcao-launcher"));
        std::fs::remove_file(&file_path).ok();
    }

    #[test]
    fn writes_prompt_with_secure_permissions() {
        let prompt = "## Test prompt\n\nHello Claude.";
        let path = write_prompt_to_tmp(prompt).expect("should write");
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, prompt);
        let metadata = std::fs::metadata(&path).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_file(&path).ok();
    }
}
