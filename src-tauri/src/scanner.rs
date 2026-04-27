use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub detected_script: Option<String>,
    pub available_scripts: Vec<String>,
    pub has_package_json: bool,
    pub package_manager: String,
    pub favicon_data_uri: Option<String>,
    pub hidden: bool,
    pub extra: bool,
}

const PREFERRED_SCRIPTS: &[&str] = &["dev:all", "dev", "start:dev", "start"];

const FAVICON_CANDIDATES: &[&str] = &[
    // SVG/PNG genéricos (preferência: vetor primeiro, raster depois)
    "public/favicon.svg",
    "public/favicon.png",
    "public/icon.svg",
    "public/icon.png",
    "public/logo.svg",
    "public/logo.png",
    // PWA standards — Next/Vite/CRA scaffolds geram esses
    "public/icon-192x192.png",
    "public/icon-256x256.png",
    "public/icon-384x384.png",
    "public/apple-touch-icon.png",
    "public/icon-512x512.png",
    // .ico por último (geralmente maior, qualidade pior em 16x16)
    "public/favicon.ico",
    // src/assets — Vite/CRA bundlados
    "src/assets/favicon.svg",
    "src/assets/favicon.png",
    "src/assets/logo.svg",
    "src/assets/logo.png",
    // assets/images — usado por governanca-mais-react e similares
    "public/assets/images/logo.png",
    "public/assets/images/logo.svg",
    "public/assets/images/icon.png",
    "public/assets/images/icon.svg",
    // Monorepos
    "apps/web/public/favicon.svg",
    "apps/web/public/favicon.png",
    "apps/web/public/favicon.ico",
    // Frameworks com static/ (SvelteKit, Astro)
    "static/favicon.svg",
    "static/favicon.png",
    "static/favicon.ico",
];

const MAX_FAVICON_BYTES: u64 = 512 * 1024;

fn read_scripts(package_json: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(package_json) else {
        return vec![];
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    value
        .get("scripts")
        .and_then(|s| s.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default()
}

fn pick_preferred(scripts: &[String]) -> Option<String> {
    PREFERRED_SCRIPTS
        .iter()
        .find(|preferred| scripts.iter().any(|s| s == *preferred))
        .map(|s| s.to_string())
}

fn detect_package_manager(dir: &Path) -> String {
    if dir.join("pnpm-lock.yaml").exists() {
        "pnpm".into()
    } else if dir.join("yarn.lock").exists() {
        "yarn".into()
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "bun".into()
    } else if dir.join("package-lock.json").exists() {
        "npm".into()
    } else {
        "pnpm".into()
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn read_image_as_data_uri(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FAVICON_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let mime = mime_for(path);
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

fn read_favicon(dir: &Path) -> Option<String> {
    for candidate in FAVICON_CANDIDATES {
        if let Some(uri) = read_image_as_data_uri(&dir.join(candidate)) {
            return Some(uri);
        }
    }
    None
}

#[derive(Serialize, Clone)]
pub struct IconCandidate {
    pub relative_path: String,
    pub data_uri: String,
    pub size_bytes: u64,
}

const ICON_DIRS: &[&str] = &[
    "public",
    "src/assets",
    "static",
    "apps/web/public",
    "public/assets/images",
    "src/assets/images",
    "assets",
    "assets/images",
];

const ICON_EXTS: &[&str] = &["svg", "png", "ico", "webp", "jpg", "jpeg", "gif"];

fn looks_like_icon_name(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("favicon")
        || n.contains("icon")
        || n.contains("logo")
        || n == "apple-touch-icon"
        || n.starts_with("brand")
}

#[tauri::command]
pub fn list_icon_candidates(project_path: String) -> Result<Vec<IconCandidate>, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("invalid project path: {}", project_path));
    }
    let mut out: Vec<IconCandidate> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    for sub in ICON_DIRS {
        let dir = root.join(sub);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
            else {
                continue;
            };
            if !ICON_EXTS.iter().any(|e| *e == ext.as_str()) {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if !looks_like_icon_name(stem) {
                continue;
            }
            let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
            if !seen.insert(canonical) {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.len() > MAX_FAVICON_BYTES {
                continue;
            }
            let Some(data_uri) = read_image_as_data_uri(&path) else {
                continue;
            };
            let relative_path = path
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| path.to_string_lossy().to_string());
            out.push(IconCandidate {
                relative_path,
                data_uri,
                size_bytes: meta.len(),
            });
        }
    }
    out.sort_by(|a, b| a.size_bytes.cmp(&b.size_bytes));
    Ok(out)
}

fn scan_dir(dir: &Path, extra: bool) -> Option<Project> {
    let name = dir.file_name()?.to_string_lossy().to_string();
    if name.starts_with('.') {
        return None;
    }

    let pkg = dir.join("package.json");
    let has_package_json = pkg.is_file();
    let available_scripts = if has_package_json {
        read_scripts(&pkg)
    } else {
        vec![]
    };
    let detected_script = pick_preferred(&available_scripts);
    let package_manager = if has_package_json {
        detect_package_manager(dir)
    } else {
        "pnpm".into()
    };
    let cfg = crate::config::project(&name);
    let favicon_data_uri = cfg
        .custom_icon_path
        .as_deref()
        .and_then(|rel| read_image_as_data_uri(&dir.join(rel)))
        .or_else(|| read_favicon(dir));
    let hidden = crate::config::is_hidden(&name);

    Some(Project {
        id: name.clone(),
        name,
        path: dir.to_string_lossy().to_string(),
        detected_script,
        available_scripts,
        has_package_json,
        package_manager,
        favicon_data_uri,
        hidden,
        extra,
    })
}

pub fn projects_root() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join("Projects"))
        .unwrap_or_else(|| PathBuf::from("./Projects"))
}

pub fn scan() -> Vec<Project> {
    let root = projects_root();
    let mut projects: Vec<Project> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.filter_map(|e| e.ok()) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Some(p) = scan_dir(&entry.path(), false) {
                seen_ids.insert(p.id.clone());
                projects.push(p);
            }
        }
    }

    for raw in crate::config::extra_paths() {
        let path = PathBuf::from(&raw);
        if !path.is_dir() {
            continue;
        }
        if let Some(mut p) = scan_dir(&path, true) {
            if seen_ids.contains(&p.id) {
                p.id = format!("{}@{}", p.id, raw);
            }
            seen_ids.insert(p.id.clone());
            projects.push(p);
        }
    }

    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    projects
}
