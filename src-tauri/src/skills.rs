use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct Skill {
    pub id: String,           // ex: "brainstorming" ou "vercel:workflow"
    pub name: String,         // do frontmatter ou fallback pra dir name
    pub description: Option<String>,
    pub source: String,       // "user" | "plugin"
    pub plugin: Option<String>,  // ex: "vercel" — só pra source=plugin
    pub path: String,         // path absoluto pro SKILL.md
    pub size_bytes: u64,
    pub modified_at: i64,     // unix ms
    pub line_count: u32,
}

fn skills_user_root() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".claude").join("skills"))
        .unwrap_or_default()
}

fn plugins_cache_root() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".claude").join("plugins").join("cache"))
        .unwrap_or_default()
}

/// Parser frontmatter YAML simplificado — extrai só `name` e `description`.
/// Lida com formatos: `key: value`, `key: "quoted value"`, ignora chaves nested.
fn parse_frontmatter(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if !text.starts_with("---") {
        return out;
    }
    // bloco entre primeiro `---` e próximo `---`
    let after_first = &text[3..];
    let end = match after_first.find("\n---") {
        Some(i) => i,
        None => return out,
    };
    let block = &after_first[..end];

    for line in block.lines() {
        // skip linhas indentadas (nested) e vazias
        if line.is_empty() || line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let key = line[..colon].trim().to_string();
        let mut value = line[colon + 1..].trim().to_string();
        // strip aspas
        if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        {
            value = value[1..value.len() - 1].to_string();
        }
        // só keys top-level relevantes
        if key == "name" || key == "description" {
            out.insert(key, value);
        }
    }
    out
}

fn read_skill_metadata(skill_md: &Path, id: String, source: String, plugin: Option<String>) -> Option<Skill> {
    let meta = fs::metadata(skill_md).ok()?;
    let text = fs::read_to_string(skill_md).ok()?;
    let frontmatter = parse_frontmatter(&text);
    let name = frontmatter
        .get("name")
        .cloned()
        .unwrap_or_else(|| id.clone());
    let description = frontmatter.get("description").cloned();
    let line_count = text.lines().count() as u32;
    let modified_at = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    Some(Skill {
        id,
        name,
        description,
        source,
        plugin,
        path: skill_md.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        modified_at,
        line_count,
    })
}

fn scan_user_skills(out: &mut Vec<Skill>) {
    let root = skills_user_root();
    let Ok(entries) = fs::read_dir(&root) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else { continue };
        if name.starts_with('.') {
            continue;
        }
        let skill_md = dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        if let Some(skill) = read_skill_metadata(&skill_md, name.to_string(), "user".to_string(), None) {
            out.push(skill);
        }
    }
}

/// Resolve a versão "mais recente" de um plugin por sort lexicográfico decrescente.
/// (Semver simples 0.40.0 < 0.40.1 funciona; "unknown" cai pra trás.)
fn pick_latest_version(plugin_dir: &Path) -> Option<PathBuf> {
    let entries: Vec<_> = fs::read_dir(plugin_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .collect();
    if entries.is_empty() {
        return None;
    }
    let mut paths: Vec<PathBuf> = entries.iter().map(|e| e.path()).collect();
    paths.sort_by(|a, b| {
        let an = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let bn = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
        bn.cmp(an)  // descending
    });
    paths.into_iter().next()
}

fn scan_plugin_skills(out: &mut Vec<Skill>) {
    let root = plugins_cache_root();
    let Ok(marketplaces) = fs::read_dir(&root) else { return };

    for marketplace in marketplaces.filter_map(|e| e.ok()) {
        if !marketplace.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(plugins) = fs::read_dir(marketplace.path()) else { continue };
        for plugin in plugins.filter_map(|e| e.ok()) {
            if !plugin.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let plugin_dir = plugin.path();
            let plugin_name = match plugin_dir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let Some(version_dir) = pick_latest_version(&plugin_dir) else { continue };
            let skills_dir = version_dir.join("skills");
            if !skills_dir.is_dir() {
                continue;
            }
            let Ok(skill_dirs) = fs::read_dir(&skills_dir) else { continue };
            for skill_entry in skill_dirs.filter_map(|e| e.ok()) {
                if !skill_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let skill_dir = skill_entry.path();
                let Some(skill_name) = skill_dir.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if skill_name.starts_with('.') {
                    continue;
                }
                let skill_md = skill_dir.join("SKILL.md");
                if !skill_md.is_file() {
                    continue;
                }
                let id = format!("{}:{}", plugin_name, skill_name);
                if let Some(skill) = read_skill_metadata(
                    &skill_md,
                    id,
                    "plugin".to_string(),
                    Some(plugin_name.clone()),
                ) {
                    out.push(skill);
                }
            }
        }
    }
}

#[tauri::command]
pub fn list_skills() -> Vec<Skill> {
    let mut out = Vec::new();
    scan_user_skills(&mut out);
    scan_plugin_skills(&mut out);
    out.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    out
}

#[tauri::command]
pub fn read_skill_content(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    // Sanity: só permite ler dentro de ~/.claude/
    let claude_root = dirs::home_dir()
        .map(|h| h.join(".claude"))
        .ok_or("home dir não encontrado")?;
    let canonical = p.canonicalize().map_err(|e| format!("canonicalize: {}", e))?;
    if !canonical.starts_with(&claude_root) {
        return Err("acesso negado: fora de ~/.claude/".into());
    }
    fs::read_to_string(&canonical).map_err(|e| format!("read: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frontmatter_basic() {
        let text = "---\nname: foo\ndescription: bar baz\n---\n\nbody";
        let fm = parse_frontmatter(text);
        assert_eq!(fm.get("name"), Some(&"foo".to_string()));
        assert_eq!(fm.get("description"), Some(&"bar baz".to_string()));
    }

    #[test]
    fn parse_frontmatter_quoted_description() {
        let text = "---\nname: foo\ndescription: \"with: colons inside\"\n---";
        let fm = parse_frontmatter(text);
        assert_eq!(fm.get("description"), Some(&"with: colons inside".to_string()));
    }

    #[test]
    fn parse_frontmatter_ignores_nested() {
        let text = "---\nname: foo\nmetadata:\n  priority: 9\n  docs:\n    - one\ndescription: real\n---";
        let fm = parse_frontmatter(text);
        assert_eq!(fm.get("name"), Some(&"foo".to_string()));
        assert_eq!(fm.get("description"), Some(&"real".to_string()));
        assert!(!fm.contains_key("priority"));
    }

    #[test]
    fn parse_frontmatter_no_frontmatter() {
        let text = "# Just a heading\n\nNo frontmatter here.";
        let fm = parse_frontmatter(text);
        assert!(fm.is_empty());
    }
}