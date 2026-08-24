#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
product_version=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",/\1/p' "$repository/package.json")
runtime_node=${WEBSPIDER_BUNDLED_NODE:-$(command -v node)}
if [ -z "$product_version" ]; then
  echo "Could not read the WebSpider version from package.json." >&2
  exit 2
fi
native_platform=$("$runtime_node" -p 'process.platform')
native_architecture=$("$runtime_node" -p 'process.arch')
native_target="$native_platform-$native_architecture"
target=${WEBSPIDER_TARGET:-$native_target}

case "$target" in
  linux-x64) release_platform=linux; release_architecture=x64 ;;
  linux-arm64) release_platform=linux; release_architecture=arm64 ;;
  darwin-x64) release_platform=macos; release_architecture=x64 ;;
  darwin-arm64) release_platform=macos; release_architecture=arm64 ;;
  *)
    echo "Unsupported WebSpider installer target: $target" >&2
    exit 2
    ;;
esac

if [ "$target" != "$native_target" ]; then
  echo "The installer must be built on its target architecture." >&2
  echo "Requested $target, but $runtime_node is $native_target." >&2
  exit 2
fi

runtime_major=$("$runtime_node" -p "Number(process.versions.node.split('.')[0])")
if [ "$runtime_major" -lt 24 ]; then
  echo "Building WebSpider requires Node.js 24 or newer." >&2
  exit 2
fi

output=${1:-"$repository/dist/WebSpider_Install_${product_version}_${release_platform}_${release_architecture}.run"}
temporary=$(mktemp -d "${TMPDIR:-/tmp}/webspider-build.XXXXXX")
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT HUP INT TERM

mkdir -p "$(dirname "$output")"
mkdir -p "$temporary/payload/app" "$temporary/payload/runtimes/$target/bin"
for entry in bin docs examples install src test web README.md package.json .gitignore; do
  cp -R "$repository/$entry" "$temporary/payload/app/"
done
cp "$runtime_node" "$temporary/payload/runtimes/$target/bin/node"
printf '%s\n' "$target" > "$temporary/payload/target"
chmod 755 "$temporary/payload/runtimes/$target/bin/node" \
  "$temporary/payload/app/bin/webspider.js" \
  "$temporary/payload/app/install/webspider-launcher.sh"
tar -czf "$temporary/payload.tar.gz" -C "$temporary" payload
sed \
  -e "s/@WEBSPIDER_VERSION@/$product_version/g" \
  -e "s/@WEBSPIDER_TARGET@/$target/g" \
  "$repository/install/installer-header.sh" > "$output"
cat "$temporary/payload.tar.gz" >> "$output"
chmod 755 "$output"
printf '%s\n' "$output"
