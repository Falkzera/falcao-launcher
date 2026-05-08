use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct ProjectConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontend_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_icon_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct DismissedVuln {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_version_at_time: Option<String>,
    pub dismissed_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub version: u32,
    #[serde(default)]
    pub projects: HashMap<String, ProjectConfig>,
    #[serde(default)]
    pub hidden: HashSet<String>,
    #[serde(default)]
    pub extra_paths: Vec<String>,
    /// Vulnerabilidades dispensadas pelo usuário (Sprint B1 — Snyk-like).
    /// Key: "source_id:cve_id" (ou "source_id:ghsa_id" / "source_id:package_name"
    /// quando não há CVE). Permite UI esconder e restaurar quando há fix novo.
    #[serde(default)]
    pub dismissed_vulnerabilities: HashMap<String, DismissedVuln>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: 1,
            projects: HashMap::new(),
            hidden: HashSet::new(),
            extra_paths: Vec::new(),
            dismissed_vulnerabilities: HashMap::new(),
        }
    }
}

fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("falcao-launcher").join("config.json"))
}

pub fn load() -> AppConfig {
    let Some(path) = config_path() else {
        return AppConfig::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return AppConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save(config: &AppConfig) -> Result<(), String> {
    let path = config_path().ok_or("could not resolve config dir")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

pub fn project(id: &str) -> ProjectConfig {
    load().projects.get(id).cloned().unwrap_or_default()
}

pub fn is_hidden(id: &str) -> bool {
    load().hidden.contains(id)
}

pub fn extra_paths() -> Vec<String> {
    load().extra_paths
}

#[tauri::command]
pub fn get_project_config(id: String) -> ProjectConfig {
    project(&id)
}

#[tauri::command]
pub fn set_project_config(id: String, config: ProjectConfig) -> Result<(), String> {
    let mut app_config = load();
    let empty = config.frontend_port.is_none()
        && config.backend_port.is_none()
        && config.custom_icon_path.is_none();
    if empty {
        app_config.projects.remove(&id);
    } else {
        app_config.projects.insert(id, config);
    }
    save(&app_config)
}

#[tauri::command]
pub fn set_project_hidden(id: String, hidden: bool) -> Result<(), String> {
    let mut app_config = load();
    if hidden {
        app_config.hidden.insert(id);
    } else {
        app_config.hidden.remove(&id);
    }
    save(&app_config)
}

#[tauri::command]
pub fn add_extra_path(path: String) -> Result<(), String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("path vazio".into());
    }
    let pb = PathBuf::from(&trimmed);
    if !pb.is_dir() {
        return Err(format!("não é um diretório: {}", trimmed));
    }
    let canonical = pb
        .canonicalize()
        .map_err(|e| format!("falha ao resolver path: {}", e))?
        .to_string_lossy()
        .to_string();
    let mut app_config = load();
    if !app_config.extra_paths.contains(&canonical) {
        app_config.extra_paths.push(canonical);
    }
    save(&app_config)
}

#[tauri::command]
pub fn remove_extra_path(path: String) -> Result<(), String> {
    let mut app_config = load();
    let before = app_config.extra_paths.len();
    app_config.extra_paths.retain(|p| p != &path);
    if app_config.extra_paths.len() == before {
        return Err(format!("path não estava na config: {}", path));
    }
    save(&app_config)
}

// ============================================================
// Sprint B1 — Snyk-like (CVEs dispensados)
// ============================================================

#[tauri::command]
pub fn dismiss_cve(
    cve_key: String,
    fix_version_at_time: Option<String>,
) -> Result<(), String> {
    let mut config = load();
    config.dismissed_vulnerabilities.insert(
        cve_key,
        DismissedVuln {
            fix_version_at_time,
            dismissed_at: chrono::Utc::now(),
        },
    );
    save(&config)
}

#[tauri::command]
pub fn undismiss_cve(cve_key: String) -> Result<(), String> {
    let mut config = load();
    config.dismissed_vulnerabilities.remove(&cve_key);
    save(&config)
}

#[tauri::command]
pub fn list_dismissed_cves() -> Result<HashMap<String, DismissedVuln>, String> {
    let config = load();
    Ok(config.dismissed_vulnerabilities)
}
