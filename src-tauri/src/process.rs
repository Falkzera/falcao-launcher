use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

static PORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:https?://)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\])(?::|]:)(\d{2,5})",
    )
    .expect("port regex must compile")
});

fn extract_port(line: &str) -> Option<u16> {
    PORT_RE
        .captures(line)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u16>().ok())
        .filter(|&p| p >= 1024)
}

#[cfg(test)]
mod tests {
    use super::extract_port;

    #[test]
    fn detects_vite_local() {
        assert_eq!(
            extract_port("  ➜  Local:   http://localhost:5173/"),
            Some(5173)
        );
    }

    #[test]
    fn detects_next() {
        assert_eq!(
            extract_port("- ready started server on 0.0.0.0:3000, url: http://localhost:3000"),
            Some(3000)
        );
    }

    #[test]
    fn detects_express() {
        assert_eq!(
            extract_port("Server running at http://127.0.0.1:8080"),
            Some(8080)
        );
    }

    #[test]
    fn detects_with_brackets_v6() {
        assert_eq!(extract_port("Listening on [::]:4000"), Some(4000));
    }

    #[test]
    fn ignores_low_ports() {
        assert_eq!(extract_port("connecting to localhost:80"), None);
    }

    #[test]
    fn no_port() {
        assert_eq!(extract_port("just a regular log line"), None);
    }
}

pub struct ProcessState {
    pub children: Mutex<HashMap<String, ChildHandle>>,
}

impl ProcessState {
    pub fn new() -> Self {
        Self {
            children: Mutex::new(HashMap::new()),
        }
    }
}

pub struct ChildHandle {
    pub abort_tx: Option<oneshot::Sender<()>>,
}

#[derive(Serialize, Clone)]
struct LogPayload {
    id: String,
    stream: &'static str,
    line: String,
}

#[derive(Serialize, Clone)]
struct StatusPayload {
    id: String,
    status: String,
    code: Option<i32>,
    message: Option<String>,
}

#[derive(Serialize, Clone)]
struct PortPayload {
    id: String,
    port: u16,
    url: String,
}

#[derive(Serialize, Clone)]
struct AllocatedPortsPayload {
    id: String,
    frontend_port: Option<u16>,
    backend_port: Option<u16>,
}

fn kill_process_group(pgid: i32, signal: i32) {
    unsafe {
        libc::kill(-pgid, signal);
    }
}

#[tauri::command]
pub async fn start_project(
    app: AppHandle,
    state: tauri::State<'_, ProcessState>,
    id: String,
    path: String,
    script: String,
    package_manager: String,
) -> Result<(), String> {
    {
        let map = state.children.lock().unwrap();
        if map.contains_key(&id) {
            return Err(format!("project '{}' is already running", id));
        }
    }

    let project_path = PathBuf::from(&path);
    if !project_path.is_dir() {
        return Err(format!("invalid project path: {}", path));
    }

    let pm_bin = match package_manager.as_str() {
        "yarn" | "bun" | "npm" => package_manager.as_str(),
        _ => "pnpm",
    };

    let project_cfg = crate::config::project(&id);
    let allocated_frontend = project_cfg
        .frontend_port
        .and_then(|p| crate::ports::find_free_port(Some(p)));
    let allocated_backend = project_cfg
        .backend_port
        .and_then(|p| crate::ports::find_free_port(Some(p)));

    let mut cmd = Command::new(pm_bin);
    if pm_bin == "yarn" {
        cmd.arg(&script);
    } else {
        cmd.arg("run").arg(&script);
    }
    cmd.current_dir(&project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);

    if let Some(p) = allocated_frontend {
        cmd.env("PORT", p.to_string());
    }
    if let Some(p) = allocated_backend {
        cmd.env("BACKEND_PORT", p.to_string());
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {}", pm_bin, e))?;
    let pgid = child.id().ok_or("could not get child pid")? as i32;

    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr = child.stderr.take().ok_or("no stderr pipe")?;

    let port_emitted = Arc::new(AtomicBool::new(false));

    let backend_port_filter = allocated_backend;

    let id_stdout = id.clone();
    let app_stdout = app.clone();
    let port_emitted_stdout = port_emitted.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if !port_emitted_stdout.load(Ordering::Relaxed) {
                if let Some(port) = extract_port(&line) {
                    if Some(port) != backend_port_filter
                        && !port_emitted_stdout.swap(true, Ordering::Relaxed)
                    {
                        let _ = app_stdout.emit(
                            "port",
                            PortPayload {
                                id: id_stdout.clone(),
                                port,
                                url: format!("http://localhost:{}", port),
                            },
                        );
                    }
                }
            }
            let _ = app_stdout.emit(
                "log",
                LogPayload {
                    id: id_stdout.clone(),
                    stream: "stdout",
                    line,
                },
            );
        }
    });

    let id_stderr = id.clone();
    let app_stderr = app.clone();
    let port_emitted_stderr = port_emitted.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if !port_emitted_stderr.load(Ordering::Relaxed) {
                if let Some(port) = extract_port(&line) {
                    if Some(port) != backend_port_filter
                        && !port_emitted_stderr.swap(true, Ordering::Relaxed)
                    {
                        let _ = app_stderr.emit(
                            "port",
                            PortPayload {
                                id: id_stderr.clone(),
                                port,
                                url: format!("http://localhost:{}", port),
                            },
                        );
                    }
                }
            }
            let _ = app_stderr.emit(
                "log",
                LogPayload {
                    id: id_stderr.clone(),
                    stream: "stderr",
                    line,
                },
            );
        }
    });

    let (abort_tx, abort_rx) = oneshot::channel::<()>();

    {
        let mut map = state.children.lock().unwrap();
        map.insert(
            id.clone(),
            ChildHandle {
                abort_tx: Some(abort_tx),
            },
        );
    }

    if allocated_frontend.is_some() || allocated_backend.is_some() {
        let _ = app.emit(
            "port-allocated",
            AllocatedPortsPayload {
                id: id.clone(),
                frontend_port: allocated_frontend,
                backend_port: allocated_backend,
            },
        );
    }

    let _ = app.emit(
        "status",
        StatusPayload {
            id: id.clone(),
            status: "running".into(),
            code: None,
            message: None,
        },
    );

    let id_sup = id.clone();
    let app_sup = app.clone();
    tauri::async_runtime::spawn(async move {
        let exit_status = tokio::select! {
            wait_result = child.wait() => wait_result,
            _ = abort_rx => {
                kill_process_group(pgid, libc::SIGTERM);
                let force_kill = tokio::time::sleep(Duration::from_secs(5));
                tokio::pin!(force_kill);
                tokio::select! {
                    res = child.wait() => res,
                    _ = &mut force_kill => {
                        kill_process_group(pgid, libc::SIGKILL);
                        child.wait().await
                    }
                }
            }
        };

        if let Some(state) = app_sup.try_state::<ProcessState>() {
            let mut map = state.children.lock().unwrap();
            map.remove(&id_sup);
        }

        let (status_str, code, message) = match exit_status {
            Ok(s) => {
                let code = s.code();
                let label = if s.success() { "stopped" } else { "crashed" };
                (label.to_string(), code, None)
            }
            Err(e) => ("crashed".to_string(), None, Some(e.to_string())),
        };

        let _ = app_sup.emit(
            "status",
            StatusPayload {
                id: id_sup.clone(),
                status: status_str,
                code,
                message,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub fn stop_project(state: tauri::State<'_, ProcessState>, id: String) -> Result<(), String> {
    let abort_tx = {
        let mut map = state.children.lock().unwrap();
        match map.get_mut(&id) {
            Some(handle) => handle.abort_tx.take(),
            None => return Err(format!("project '{}' is not running", id)),
        }
    };
    if let Some(tx) = abort_tx {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub fn running_ids(state: tauri::State<'_, ProcessState>) -> Vec<String> {
    let map = state.children.lock().unwrap();
    map.keys().cloned().collect()
}
