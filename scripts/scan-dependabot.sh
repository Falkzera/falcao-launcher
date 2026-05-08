#!/usr/bin/env bash
# Scaneia Dependabot alerts em todos os repos Falkzera/* + GHSA cross-cutting.
# Output: CSV em stdout. Header + N linhas (uma por CVE encontrado).
#
# Schema CSV: ts,kind,severity,cve_id,ghsa_id,source_id,package_name,package_version,fix_version,title,url,state
#
# Requer: gh CLI autenticada (GH_TOKEN no env CI, ou gh auth login local).

set -euo pipefail

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# CSV header
echo "ts,kind,severity,cve_id,ghsa_id,source_id,package_name,package_version,fix_version,title,url,state"

# 1. Dependabot alerts por repo Falkzera/*
REPOS=$(gh api /user/repos --paginate --jq '.[] | select(.owner.login=="Falkzera" and .archived == false) | .full_name')

# Coletar packages únicos pra GHSA query depois
declare -A SEEN_PACKAGES

for repo in $REPOS; do
  alerts_json=$(gh api "/repos/$repo/dependabot/alerts?state=open&per_page=100" --paginate 2>/dev/null) || {
    echo "[scan-dependabot] skip $repo: dependabot disabled or 404" >&2
    continue
  }

  echo "$alerts_json" | jq -r --arg ts "$NOW" --arg src "$repo" '
    .[] | [
      $ts,
      "deps",
      (.security_advisory.severity // "unknown"),
      (.security_advisory.cve_id // ""),
      (.security_advisory.ghsa_id // ""),
      $src,
      (.dependency.package.name // ""),
      (.security_vulnerability.vulnerable_version_range // ""),
      (.security_vulnerability.first_patched_version.identifier // ""),
      (.security_advisory.summary // ""),
      (.html_url // ""),
      "open"
    ] | @csv'

  # Acumula nomes de packages pra GHSA cross-check (ecosystem:name)
  while IFS= read -r pkg; do
    [[ -z "$pkg" || "$pkg" == "null" || "$pkg" == ":" ]] && continue
    SEEN_PACKAGES["$pkg"]=1
  done < <(echo "$alerts_json" | jq -r '.[] | "\(.dependency.package.ecosystem):\(.dependency.package.name)"')
done

# 2. GHSA cross-cutting: top 10 advisories mais recentes pra cada package que apareceu.
#    Filtra por affects=<package> via gh api advisories.
for ecosystem_pkg in "${!SEEN_PACKAGES[@]}"; do
  ecosystem="${ecosystem_pkg%%:*}"
  pkg="${ecosystem_pkg##*:}"
  [[ -z "$pkg" || -z "$ecosystem" ]] && continue

  gh api "/advisories?ecosystem=$ecosystem&affects=$pkg&per_page=10&sort=published&direction=desc" 2>/dev/null | \
    jq -r --arg ts "$NOW" --arg src "ghsa:$ecosystem:$pkg" --arg pkg "$pkg" '
      (. // [])[] | [
        $ts,
        "advisory",
        (.severity // "unknown"),
        (.cve_id // ""),
        (.ghsa_id // ""),
        $src,
        $pkg,
        "",
        "",
        (.summary // ""),
        (.html_url // ""),
        "open"
      ] | @csv' || continue
done
