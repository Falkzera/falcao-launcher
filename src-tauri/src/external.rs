use std::path::PathBuf;
use std::process::{Command, Stdio};

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
