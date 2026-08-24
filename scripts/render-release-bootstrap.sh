#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
github_repository=${1:-}
product_version=${2:-$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repository_root/package.json")}
output=${3:-"$repository_root/dist/WebSpider_Install.run"}

if ! printf '%s\n' "$github_repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "Usage: $0 OWNER/REPOSITORY [VERSION] [OUTPUT]" >&2
  exit 2
fi
if ! printf '%s\n' "$product_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.-]+)?$'; then
  echo "Invalid release version: $product_version" >&2
  exit 2
fi

mkdir -p "$(dirname "$output")"
sed \
  -e "s|@GITHUB_REPOSITORY@|$github_repository|g" \
  -e "s|@WEBSPIDER_VERSION@|$product_version|g" \
  "$repository_root/install/release-bootstrap.sh" > "$output"
chmod 755 "$output"
printf '%s\n' "$output"
