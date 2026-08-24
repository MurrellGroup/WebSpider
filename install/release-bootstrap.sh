#!/bin/sh
set -eu

repository='@GITHUB_REPOSITORY@'
version='@WEBSPIDER_VERSION@'
github_token=${GH_TOKEN:-${GITHUB_TOKEN:-}}

case "$repository:$version" in
  *@*)
    echo "This bootstrap installer was not rendered for a GitHub Release." >&2
    exit 2
    ;;
esac

case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=macos ;;
  *) echo "WebSpider supports Linux and macOS." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) architecture=x64 ;;
  arm64|aarch64) architecture=arm64 ;;
  *) echo "Unsupported processor architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="WebSpider_Install_${version}_${platform}_${architecture}.run"
release_base=${WEBSPIDER_RELEASE_BASE_URL:-"https://github.com/$repository/releases/download/v$version"}
temporary=$(mktemp -d "${TMPDIR:-/tmp}/webspider-release.XXXXXX")
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT HUP INT TERM

download() {
  source_url=$1
  destination=$2
  if [ -n "$github_token" ] && [ -z "${WEBSPIDER_RELEASE_BASE_URL:-}" ]; then
    release_json="$temporary/release.json"
    if [ ! -s "$release_json" ]; then
      metadata_url="https://api.github.com/repos/$repository/releases/tags/v$version"
      if command -v curl >/dev/null 2>&1; then
        curl --http1.1 -fsSL --retry 5 --retry-delay 2 \
          --header "Accept: application/vnd.github+json" \
          --header "Authorization: Bearer $github_token" \
          --output "$release_json" "$metadata_url"
      elif command -v wget >/dev/null 2>&1; then
        wget -q \
          --header="Accept: application/vnd.github+json" \
          --header="Authorization: Bearer $github_token" \
          -O "$release_json" "$metadata_url"
      else
        echo "Downloading WebSpider requires curl or wget." >&2
        exit 1
      fi
    fi
    asset_name=$(basename "$source_url")
    asset_api_url=$(awk -v wanted="$asset_name" '
      $1 == "\"url\":" && $2 ~ /^\"https:\/\/api.github.com\/repos\/.*\/releases\/assets\// {
        candidate=$2; gsub(/[\",]/, "", candidate)
      }
      $1 == "\"name\":" {
        name=$2; gsub(/[\",]/, "", name)
        if (name == wanted) { print candidate; exit }
      }
    ' "$release_json")
    if [ -z "$asset_api_url" ]; then
      echo "The private release asset $asset_name was not found." >&2
      exit 1
    fi
    if command -v curl >/dev/null 2>&1; then
      curl --http1.1 -fL --retry 5 --retry-delay 2 \
        --header "Accept: application/octet-stream" \
        --header "Authorization: Bearer $github_token" \
        --output "$destination" "$asset_api_url"
    else
      wget \
        --header="Accept: application/octet-stream" \
        --header="Authorization: Bearer $github_token" \
        -O "$destination" "$asset_api_url"
    fi
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    curl --http1.1 -fL --retry 5 --retry-delay 2 --output "$destination" "$source_url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$destination" "$source_url"
  else
    echo "Downloading WebSpider requires curl or wget." >&2
    exit 1
  fi
}

download "$release_base/$asset" "$temporary/$asset"
download "$release_base/SHA256SUMS" "$temporary/SHA256SUMS"

expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$temporary/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "The release checksum for $asset is missing." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')
else
  echo "WebSpider could not find a SHA-256 verification tool." >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "The downloaded WebSpider installer failed checksum verification." >&2
  exit 1
fi

sh "$temporary/$asset" "$@"
