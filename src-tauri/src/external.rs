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
pub fn spawn_claude(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    let mut cmd = Command::new("ghostty");
    cmd.arg(format!("--working-directory={}", p.display()))
        .arg("-e")
        .arg("claude");
    spawn_detached(&mut cmd).map_err(|e| format!("falha ao spawnar Claude: {}", e))
}
