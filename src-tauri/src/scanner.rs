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
    pub worktree: Option<WorktreeInfo>,
    pub monorepo_parent: Option<MonorepoParentInfo>,
}

#[derive(Serialize, Clone)]
pub struct WorktreeInfo {
    pub parent_id: String,
    pub parent_path: String,
    pub branch: String,
}

#[derive(Serialize, Clone)]
pub struct MonorepoParentInfo {
    pub id: String,
    pub name: String,
    pub path: String,
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

fn build_project(
    dir: &Path,
    id: String,
    display_name: String,
    extra: bool,
    worktree: Option<WorktreeInfo>,
    monorepo_parent: Option<MonorepoParentInfo>,
) -> Option<Project> {
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
    let cfg = crate::config::project(&id);
    let favicon_data_uri = cfg
        .custom_icon_path
        .as_deref()
        .and_then(|rel| read_image_as_data_uri(&dir.join(rel)))
        .or_else(|| read_favicon(dir));
    let hidden = crate::config::is_hidden(&id);

    Some(Project {
        id,
        name: display_name,
        path: dir.to_string_lossy().to_string(),
        detected_script,
        available_scripts,
        has_package_json,
        package_manager,
        favicon_data_uri,
        hidden,
        extra,
        worktree,
        monorepo_parent,
    })
}

fn scan_dir(dir: &Path, extra: bool) -> Option<Project> {
    let name = dir.file_name()?.to_string_lossy().to_string();
    if name.starts_with('.') {
        return None;
    }
    build_project(dir, name.clone(), name, extra, None, None)
}

fn detect_worktree(dir: &Path) -> Option<WorktreeInfo> {
    let git_path = dir.join(".git");
    let meta = fs::metadata(&git_path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let content = fs::read_to_string(&git_path).ok()?;
    let gitdir_str = content
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:").map(|s| s.trim()))?;
    let gitdir = PathBuf::from(gitdir_str);

    let head = fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let branch = head
        .trim()
        .strip_prefix("ref: refs/heads/")
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let trimmed = head.trim();
            if trimmed.len() >= 7 {
                format!("({})", &trimmed[..7])
            } else {
                "(detached)".into()
            }
        });

    // gitdir typically looks like: <parent>/.git/worktrees/<wt-name>
    // Walk up to <parent>.
    let parent_path = gitdir.parent()?.parent()?.parent()?.to_path_buf();
    let parent_id = parent_path.file_name()?.to_string_lossy().to_string();

    Some(WorktreeInfo {
        parent_id,
        parent_path: parent_path.to_string_lossy().to_string(),
        branch,
    })
}

fn collect_worktrees(
    parent_dir: &Path,
    out: &mut Vec<Project>,
    seen_ids: &mut std::collections::HashSet<String>,
) {
    let wt_root = parent_dir.join(".claude").join("worktrees");
    let Ok(entries) = fs::read_dir(&wt_root) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let Some(wt_name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        if wt_name.starts_with('.') {
            continue;
        }
        let Some(wt_info) = detect_worktree(&path) else {
            continue;
        };
        let id = format!("{}/{}", wt_info.parent_id, wt_name);
        if seen_ids.contains(&id) {
            continue;
        }
        let Some(project) = build_project(
            &path,
            id.clone(),
            wt_name,
            false,
            Some(wt_info),
            None,
        ) else {
            continue;
        };
        seen_ids.insert(id);
        out.push(project);
    }
}

/// Detects pseudo-monorepos: a directory without `package.json` whose immediate
/// children include at least one `package.json`. Used to surface the children
/// as projects under a shared visual group, hiding the empty parent shell.
fn collect_monorepo_children(
    parent_dir: &Path,
    out: &mut Vec<Project>,
    seen_ids: &mut std::collections::HashSet<String>,
) -> bool {
    let Some(parent_name) = parent_dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(String::from)
    else {
        return false;
    };
    let Ok(entries) = fs::read_dir(parent_dir) else {
        return false;
    };
    let candidates: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.starts_with('.') && p.join("package.json").is_file())
                .unwrap_or(false)
        })
        .collect();

    if candidates.is_empty() {
        return false;
    }

    let mr_info = MonorepoParentInfo {
        id: parent_name.clone(),
        name: parent_name.clone(),
        path: parent_dir.to_string_lossy().to_string(),
    };

    for child in candidates {
        let Some(child_name) = child.file_name().and_then(|n| n.to_str()).map(String::from)
        else {
            continue;
        };
        let id = format!("{}/{}", parent_name, child_name);
        if seen_ids.contains(&id) {
            continue;
        }
        let Some(project) = build_project(
            &child,
            id.clone(),
            child_name,
            false,
            None,
            Some(mr_info.clone()),
        ) else {
            continue;
        };
        seen_ids.insert(id);
        out.push(project);
    }
    true
}

fn project_sort_key(p: &Project) -> (String, u8, String) {
    if let Some(wt) = &p.worktree {
        (wt.parent_id.to_lowercase(), 1, p.name.to_lowercase())
    } else if let Some(mr) = &p.monorepo_parent {
        (mr.id.to_lowercase(), 0, p.name.to_lowercase())
    } else {
        (p.name.to_lowercase(), 0, String::new())
    }
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
            let path = entry.path();
            let has_pkg = path.join("package.json").is_file();
            if !has_pkg {
                if collect_monorepo_children(&path, &mut projects, &mut seen_ids) {
                    continue;
                }
            }
            if let Some(p) = scan_dir(&path, false) {
                seen_ids.insert(p.id.clone());
                projects.push(p);
            }
            collect_worktrees(&path, &mut projects, &mut seen_ids);
        }
    }

    for raw in crate::config::extra_paths() {
        let path = PathBuf::from(&raw);
        if !path.is_dir() {
            continue;
        }
        let has_pkg = path.join("package.json").is_file();
        if !has_pkg {
            if collect_monorepo_children(&path, &mut projects, &mut seen_ids) {
                continue;
            }
        }
        if let Some(mut p) = scan_dir(&path, true) {
            if seen_ids.contains(&p.id) {
                p.id = format!("{}@{}", p.id, raw);
            }
            seen_ids.insert(p.id.clone());
            projects.push(p);
        }
        collect_worktrees(&path, &mut projects, &mut seen_ids);
    }

    projects.sort_by(|a, b| project_sort_key(a).cmp(&project_sort_key(b)));
    projects
}