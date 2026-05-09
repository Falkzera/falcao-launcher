//! SSH tunnel via processo `ssh` (mais robusto que russh pra Fase 1).
//!
//! Refcount: múltiplos componentes React (`useTunnel` em VmTab/SecurityTab/
//! CostTab/AnalysisPage) podem coexistir. Cada `open()` incrementa o contador,
//! cada `close()` decrementa. O processo SSH só morre quando o último consumer
//! sai. Sem isso, fechar uma aba mataria o tunnel das outras.

use anyhow::{Context, Result};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tokio::process::{Child, Command};

const VM_HOST: &str = "falcao@162.55.217.189";
const REMOTE_PORT: u16 = 5432;
pub const LOCAL_PORT: u16 = 54322;

pub struct TunnelManager {
    child: Mutex<Option<Child>>,
    refcount: AtomicUsize,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            refcount: AtomicUsize::new(0),
        }
    }

    /// Incrementa refcount + spawna SSH se for o primeiro consumer.
    /// Retorna `(port, is_first)`. `is_first` permite ao caller decidir
    /// se deve criar o pool Postgres novo ou reutilizar.
    pub async fn open(&self) -> Result<(u16, bool)> {
        let prev = self.refcount.fetch_add(1, Ordering::SeqCst);
        let is_first = prev == 0;

        // Scope lock para não atravessar o .await abaixo
        {
            let mut guard = self.child.lock().unwrap();
            if guard.is_some() {
                return Ok((LOCAL_PORT, is_first));
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
        }

        // Pequeno delay pra tunnel ficar pronto
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok((LOCAL_PORT, is_first))
    }

    /// Decrementa refcount (saturating em 0). Mata o processo SSH só quando o
    /// último consumer sai. Retorna `is_last` pra caller decidir se deve
    /// dropar o pool Postgres.
    pub async fn close(&self) -> Result<bool> {
        let new_count = self
            .refcount
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |c| {
                if c == 0 {
                    None
                } else {
                    Some(c - 1)
                }
            })
            .map(|prev| prev - 1)
            .unwrap_or(0);

        if new_count > 0 {
            return Ok(false);
        }

        let child_opt = {
            let mut guard = self.child.lock().unwrap();
            guard.take()
        };
        if let Some(mut child) = child_opt {
            let _ = child.kill().await;
        }
        Ok(true)
    }

    // API pública reservada (ex: health check programático do tunnel).
    #[allow(dead_code)]
    pub fn is_open(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    #[allow(dead_code)]
    pub fn refcount(&self) -> usize {
        self.refcount.load(Ordering::SeqCst)
    }
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}
