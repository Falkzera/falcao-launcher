use procfs::net::TcpState;
use procfs::process::FDTarget;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct SystemListener {
    pub port: u16,
    pub pid: u32,
    pub address: String,
    pub cwd: Option<String>,
    pub cmd: Option<String>,
}

fn is_local_addr(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
    }
}

fn collect_listening_inodes() -> HashMap<u64, (u16, String)> {
    let mut out: HashMap<u64, (u16, String)> = HashMap::new();
    if let Ok(entries) = procfs::net::tcp() {
        for e in entries {
            if e.state != TcpState::Listen {
                continue;
            }
            let ip = e.local_address.ip();
            let port = e.local_address.port();
            if port < 1024 || !is_local_addr(&ip) {
                continue;
            }
            out.insert(e.inode, (port, ip.to_string()));
        }
    }
    if let Ok(entries) = procfs::net::tcp6() {
        for e in entries {
            if e.state != TcpState::Listen {
                continue;
            }
            let ip = e.local_address.ip();
            let port = e.local_address.port();
            if port < 1024 || !is_local_addr(&ip) {
                continue;
            }
            out.insert(e.inode, (port, ip.to_string()));
        }
    }
    out
}

pub fn scan_listeners() -> Vec<SystemListener> {
    let listening = collect_listening_inodes();
    if listening.is_empty() {
        return vec![];
    }

    let mut out: Vec<SystemListener> = Vec::new();
    let mut seen: HashSet<(u32, u16)> = HashSet::new();

    let Ok(processes) = procfs::process::all_processes() else {
        return out;
    };
    for proc_res in processes {
        let Ok(proc) = proc_res else { continue };
        let pid = proc.pid as u32;
        let Ok(fds) = proc.fd() else { continue };
        for fd_res in fds {
            let Ok(fd) = fd_res else { continue };
            if let FDTarget::Socket(inode) = fd.target {
                if let Some((port, addr)) = listening.get(&inode) {
                    if !seen.insert((pid, *port)) {
                        continue;
                    }
                    let cwd = proc.cwd().ok().map(|p| p.to_string_lossy().to_string());
                    let cmd = proc.cmdline().ok().map(|args| args.join(" "));
                    out.push(SystemListener {
                        port: *port,
                        pid,
                        address: addr.clone(),
                        cwd,
                        cmd,
                    });
                }
            }
        }
    }

    out.sort_by(|a, b| a.port.cmp(&b.port).then(a.pid.cmp(&b.pid)));
    out
}

pub fn snapshot_signature(listeners: &[SystemListener]) -> Vec<(u32, u16)> {
    let mut sig: Vec<(u32, u16)> = listeners.iter().map(|l| (l.pid, l.port)).collect();
    sig.sort();
    sig
}

#[tauri::command]
pub fn list_system_ports() -> Vec<SystemListener> {
    scan_listeners()
}
