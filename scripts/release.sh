#!/usr/bin/env bash
#
# Release script for Astra using Calendar Versioning (CalVer)
#
# Version format: YYYY.MM.MICRO
#   YYYY  = 4-digit year
#   MM    = month (1-12, no zero-padding)
#   MICRO = patch number within the month, starting at 0
#
# This script triggers a GitHub Actions release workflow.
# It can also be used to just bump versions locally.
#
# Usage:
#   ./scripts/release.sh              # Auto-increment and trigger release
#   ./scripts/release.sh 2026.3.0     # Set explicit version
#   ./scripts/release.sh --dry-run    # Show what would happen
#   ./scripts/release.sh --local      # Only bump versions locally, no release
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=false
LOCAL_ONLY=false
EXPLICIT_VERSION=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    --local)
      LOCAL_ONLY=true
      ;;
    *)
      EXPLICIT_VERSION="$arg"
      ;;
  esac
done

# Files that contain version strings
PACKAGE_JSON="$ROOT_DIR/package.json"
CARGO_TOML="$ROOT_DIR/src-tauri/Cargo.toml"
TAURI_CONF="$ROOT_DIR/src-tauri/tauri.conf.json"
PYPROJECT="$ROOT_DIR/python/pyproject.toml"

# Read current version from package.json
CURRENT_VERSION=$(grep '"version"' "$PACKAGE_JSON" | head -1 | sed 's/.*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/')

echo "Current version: $CURRENT_VERSION"

if [[ -n "$EXPLICIT_VERSION" ]]; then
  NEW_VERSION="$EXPLICIT_VERSION"
else
  # Auto-increment: parse current version
  IFS='.' read -r CUR_YEAR CUR_MONTH CUR_MICRO <<< "$CURRENT_VERSION"

  # Get current date
  NOW_YEAR=$(date +%Y)
  NOW_MONTH=$(date +%-m)

  if [[ "$CUR_YEAR" == "$NOW_YEAR" && "$CUR_MONTH" == "$NOW_MONTH" ]]; then
    # Same month: increment micro
    NEW_MICRO=$((CUR_MICRO + 1))
    NEW_VERSION="${NOW_YEAR}.${NOW_MONTH}.${NEW_MICRO}"
  else
    # New month: reset micro to 0
    NEW_VERSION="${NOW_YEAR}.${NOW_MONTH}.0"
  fi
fi

echo "New version: $NEW_VERSION"

if $DRY_RUN; then
  echo ""
  echo "[dry-run] Would update version in:"
  echo "  - $PACKAGE_JSON"
  echo "  - $CARGO_TOML"
  echo "  - $TAURI_CONF"
  echo "  - $PYPROJECT"
  if $LOCAL_ONLY; then
    echo "[dry-run] Would commit version bump locally"
  else
    echo "[dry-run] Would trigger GitHub Actions release workflow"
  fi
  exit 0
fi

# Confirm
echo ""
read -p "Release v${NEW_VERSION}? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

if $LOCAL_ONLY; then
  # Update version in all files locally
  echo "Updating versions..."

  node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PACKAGE_JSON', 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$PACKAGE_JSON', JSON.stringify(pkg, null, 2) + '\n');
  "

  sed -i "0,/^version = \".*\"/s//version = \"$NEW_VERSION\"/" "$CARGO_TOML"
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$TAURI_CONF"
  sed -i "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$PYPROJECT"

  echo "Updated all version files to $NEW_VERSION"

  git add "$PACKAGE_JSON" "$CARGO_TOML" "$TAURI_CONF" "$PYPROJECT"
  git commit -m "release: v${NEW_VERSION}"

  echo ""
  echo "Version bumped locally. Push when ready:"
  echo "  git push origin main"
else
  # Trigger GitHub Actions release workflow
  echo "Triggering GitHub Actions release workflow..."

  if ! command -v gh &> /dev/null; then
    echo "Error: GitHub CLI (gh) is not installed."
    echo "Install it: https://cli.github.com/"
    exit 1
  fi

  gh workflow run release.yml --field version="$NEW_VERSION"

  echo ""
  echo "Release workflow triggered for v${NEW_VERSION}"
  echo "Watch progress: gh run list --workflow=release.yml"
fi
