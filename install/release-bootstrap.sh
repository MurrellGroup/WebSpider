#!/bin/sh
set -eu

repository='@GITHUB_REPOSITORY@'
version='@WEBSPIDER_VERSION@'

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
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --output "$destination" "$source_url"
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
