#!/bin/sh
set -eu

version="${BERRY_VERSION:-__BERRY_VERSION__}"
repository="${BERRY_GITHUB_REPOSITORY:-__BERRY_GITHUB_REPOSITORY__}"
install_dir="${BERRY_INSTALL_DIR:-$HOME/.local/bin}"

if [ "$version" = "__BERRY_VERSION__" ]; then
  echo "Berry release version is not configured. Set BERRY_VERSION." >&2
  exit 1
fi

if [ -n "${BERRY_TARGET:-}" ]; then
  target="$BERRY_TARGET"
else
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64) target="aarch64-apple-darwin" ;;
    Darwin/x86_64) target="x86_64-apple-darwin" ;;
    Linux/aarch64|Linux/arm64) target="aarch64-unknown-linux-gnu" ;;
    Linux/x86_64|Linux/amd64) target="x86_64-unknown-linux-gnu" ;;
    *) echo "Unsupported Berry CLI platform: $os/$arch" >&2; exit 1 ;;
  esac
fi

if [ -n "${BERRY_DOWNLOAD_BASE_URL:-}" ]; then
  base_url="$BERRY_DOWNLOAD_BASE_URL"
elif [ "$repository" = "__BERRY_GITHUB_REPOSITORY__" ]; then
  echo "Berry release repository is not configured. Set BERRY_GITHUB_REPOSITORY=owner/repo." >&2
  exit 1
else
  base_url="https://github.com/$repository/releases/download/cli-v$version"
fi

name="berry-$target"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

curl --fail --location --silent --show-error "$base_url/$name" --output "$tmp_dir/$name"
curl --fail --location --silent --show-error "$base_url/$name.sha256" --output "$tmp_dir/$name.sha256"
expected="$(awk '{print $1}' "$tmp_dir/$name.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp_dir/$name" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp_dir/$name" | awk '{print $1}')"
fi
if [ "$actual" != "$expected" ]; then
  echo "Berry CLI checksum mismatch for $name" >&2
  exit 1
fi

mkdir -p "$install_dir"
chmod 755 "$tmp_dir/$name"
mv "$tmp_dir/$name" "$install_dir/berry"
echo "Installed berry $version to $install_dir/berry"
