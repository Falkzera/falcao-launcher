//! SSH tunnel via processo `ssh` (mais robusto que russh pra Fase 1).

use anyhow::{Context, Result};
use std::sync::Mutex;
use tokio::process::{Child, Command};

const VM_HOST: &str = "falcao@162.55.217.189";
const REMOTE_PORT: u16 = 5432;
pub const LOCAL_PORT: u16 = 54322;

pub struct TunnelManager {
    child: Mutex<Option<Child>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub async fn open(&self) -> Result<u16> {
        let mut guard = self.child.lock().unwrap();
        if guard.is_some() {
            return Ok(LOCAL_PORT);
        }

        let child = Command::new("ssh")
            .args([
                "-N",
                "-L",
                &format!("{}:localhost:{}", LOCAL_PORT, REMOTE_PORT),
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ExitOnForwardFailure=yes",
                VM_HOST,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .context("spawn ssh")?;

        *guard = Some(child);

        // Pequeno delay pra tunnel ficar pronto
        drop(guard);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok(LOCAL_PORT)
    }

    pub async fn close(&self) -> Result<()> {
        let child_opt = {
            let mut guard = self.child.lock().unwrap();
            guard.take()
        };
        if let Some(mut child) = child_opt {
            let _ = child.kill().await;
        }
        Ok(())
    }

    pub fn is_open(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}
