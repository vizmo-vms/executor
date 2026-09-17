#!/bin/sh
set -uf

case "${1:-}" in
  *Username*)
    printf '%s\n' x-access-token
    exit
    ;;
  *Password*)
    printf '%s\n' "${EXECUTOR_CODEGRAPH_GITHUB_TOKEN:-}"
    exit
    ;;
esac

workspace="${EXECUTOR_CODEGRAPH_WORKSPACE:-/workspace}"
repositories="${EXECUTOR_CODEGRAPH_GITHUB_REPOS:-}"
branch="${EXECUTOR_CODEGRAPH_GITHUB_BRANCH:-prod}"
github_base_url="${EXECUTOR_CODEGRAPH_GITHUB_BASE_URL:-https://github.com}"
github_base_url="${github_base_url%/}"
export GIT_TERMINAL_PROMPT=0

if [ -n "${EXECUTOR_CODEGRAPH_GITHUB_TOKEN:-}" ]; then
  GIT_ASKPASS="$(command -v "$0" 2>/dev/null || printf '%s' "$0")"
  export GIT_ASKPASS
fi

[ -n "$repositories" ] || exit 0
mkdir -p "$workspace"

previous_ifs="$IFS"
IFS=,
set -- $repositories
IFS="$previous_ifs"

for slug do
  slug="$(printf '%s' "$slug" | tr -d '[:space:]')"
  slug="${slug%.git}"
  case "$slug" in
    "" | /* | *..* | */*/* | *[!A-Za-z0-9._/-]*)
      echo "[executor] invalid GitHub repository: $slug" >&2
      continue
      ;;
  esac

  owner="${slug%/*}"
  name="${slug#*/}"
  if [ "$owner" = "$slug" ] || [ -z "$owner" ] || [ -z "$name" ]; then
    echo "[executor] GitHub repositories must use owner/name: $slug" >&2
    continue
  fi

  repo="$workspace/$owner/$name"
  updated=false

  if [ ! -d "$repo/.git" ]; then
    if [ -e "$repo" ]; then
      echo "[executor] repository path exists but is not a Git checkout: $repo" >&2
      continue
    fi
    mkdir -p "$workspace/$owner"
    if git clone --branch "$branch" --single-branch --quiet "$github_base_url/$slug.git" "$repo"; then
      updated=true
    else
      echo "[executor] repository clone failed: $slug" >&2
      continue
    fi
  elif [ "$(git -C "$repo" branch --show-current 2>/dev/null)" != "$branch" ]; then
    echo "[executor] skipping repository on a branch other than $branch: $repo" >&2
  elif ! git -C "$repo" diff --quiet || ! git -C "$repo" diff --cached --quiet; then
    echo "[executor] skipping dirty repository: $repo" >&2
  else
    before="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || continue
    if git -C "$repo" pull --ff-only --quiet origin "$branch"; then
      after="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || continue
      [ "$before" = "$after" ] || updated=true
    else
      echo "[executor] repository sync failed: $repo" >&2
    fi
  fi

  if [ -d "$repo/.codegraph" ]; then
    codegraph_action=sync
  else
    codegraph_action=init
  fi

  if env -u EXECUTOR_CODEGRAPH_GITHUB_TOKEN -u GIT_ASKPASS \
    codegraph "$codegraph_action" "$repo" >/dev/null; then
    [ "$updated" = false ] || echo "[executor] repository and CodeGraph index synced: $repo"
  else
    echo "[executor] CodeGraph sync failed: $repo" >&2
  fi
done
