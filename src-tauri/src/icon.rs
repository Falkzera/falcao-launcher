use base64::{engine::general_purpose::STANDARD, Engine as _};
use once_cell::sync::Lazy;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

static ACTIVE_THEME: Lazy<Option<String>> = Lazy::new(detect_active_theme);

fn detect_active_theme() -> Option<String> {
    let output = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "icon-theme"])
        .output()
        .ok()?;
    let raw = String::from_utf8(output.stdout).ok()?;
    let theme = raw.trim().trim_matches('\'').trim_matches('"').to_string();
    if theme.is_empty() {
        None
    } else {
        Some(theme)
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
        Some("xpm") => "image/x-xpixmap",
        _ => "application/octet-stream",
    }
}

fn lookup_with_theme(name: &str, size: u16, theme: &str) -> Option<PathBuf> {
    freedesktop_icons::lookup(name)
        .with_size(size)
        .with_scale(1)
        .with_theme(theme)
        .find()
}

fn lookup_default(name: &str, size: u16) -> Option<PathBuf> {
    freedesktop_icons::lookup(name)
        .with_size(size)
        .with_scale(1)
        .find()
}

#[tauri::command]
pub fn resolve_icon(name: String, size: u16) -> Option<String> {
    let path = ACTIVE_THEME
        .as_deref()
        .and_then(|theme| lookup_with_theme(&name, size, theme))
        .or_else(|| lookup_default(&name, size))?;

    let bytes = fs::read(&path).ok()?;
    if bytes.len() > 512 * 1024 {
        return None;
    }
    let mime = mime_for(&path);
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}
