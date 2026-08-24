#!/bin/sh
set -eu

product_version=@WEBSPIDER_VERSION@
expected_target=@WEBSPIDER_TARGET@
workspace=$(pwd)
install_root=${WEBSPIDER_INSTALL_DIR:-"$HOME/.local/lib/webspider"}
bin_dir=${WEBSPIDER_BIN_DIR:-"$HOME/.local/bin"}
state_dir=${WEBSPIDER_STATE_DIR:-"${XDG_DATA_HOME:-$HOME/.local/share}/webspider"}
install_service=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace) workspace=$2; shift 2 ;;
    --install-dir) install_root=$2; shift 2 ;;
    --bin-dir) bin_dir=$2; shift 2 ;;
    --state-dir) state_dir=$2; shift 2 ;;
    --no-service) install_service=0; shift ;;
    -h|--help)
      echo "Usage: sh WebSpider_Install_${product_version}.run [--workspace PATH] [--no-service]"
      exit 0
      ;;
    *) echo "Unknown installer option: $1" >&2; exit 2 ;;
  esac
done

workspace=$(cd "$workspace" 2>/dev/null && pwd) || {
  echo "Workspace does not exist: $workspace" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) platform=linux; pty_helper=script ;;
  Darwin) platform=darwin; pty_helper=expect ;;
  *) echo "WebSpider supports Linux and macOS." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) architecture=x64 ;;
  arm64|aarch64) architecture=arm64 ;;
  *) echo "Unsupported processor architecture: $(uname -m)" >&2; exit 1 ;;
esac
actual_target="$platform-$architecture"
if [ "$actual_target" != "$expected_target" ]; then
  echo "This installer targets $expected_target, but this machine is $actual_target." >&2
  echo "Download the matching asset from the same WebSpider GitHub Release." >&2
  exit 1
fi
for helper in "$pty_helper" mkfifo; do
  if ! command -v "$helper" >/dev/null 2>&1; then
    echo "WebSpider requires the system utility '$helper' on this platform." >&2
    exit 1
  fi
done

temporary=$(mktemp -d "${TMPDIR:-/tmp}/webspider-install.XXXXXX")
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT HUP INT TERM
archive_line=$(awk '/^__WEBSPIDER_ARCHIVE_BELOW__$/ { print NR + 1; exit }' "$0")
if [ -z "$archive_line" ]; then
  echo "Installer payload is missing." >&2
  exit 1
fi
tail -n "+$archive_line" "$0" | tar -xzf - -C "$temporary"

embedded="$temporary/payload/runtimes/$platform-$architecture"
runtime_source=$embedded
payload_target=$(sed -n '1p' "$temporary/payload/target" 2>/dev/null || true)
if [ "$payload_target" != "$expected_target" ] || [ ! -x "$runtime_source/bin/node" ]; then
  echo "The installer payload is incomplete or targets the wrong platform." >&2
  exit 1
fi
runtime_target=$("$runtime_source/bin/node" -p '`${process.platform}-${process.arch}`')
if [ "$runtime_target" != "$expected_target" ]; then
  echo "The bundled runtime does not match this installer." >&2
  exit 1
fi

stage="$install_root.stage.$$"
previous="$install_root.previous"
rm -rf "$stage"
mkdir -p "$stage/app" "$stage/runtime/bin"
cp -R "$temporary/payload/app/." "$stage/app/"
cp "$runtime_source/bin/node" "$stage/runtime/bin/node"
chmod 755 "$stage/runtime/bin/node"
for helper in script mkfifo; do
  if [ -x "$runtime_source/bin/$helper" ]; then
    cp "$runtime_source/bin/$helper" "$stage/runtime/bin/$helper"
    chmod 755 "$stage/runtime/bin/$helper"
  fi
done

mkdir -p "$(dirname "$install_root")" "$bin_dir" "${XDG_CONFIG_HOME:-$HOME/.config}/webspider" "$state_dir"
rm -rf "$previous"
if [ -d "$install_root/app" ]; then
  mv "$install_root" "$previous"
fi
mv "$stage" "$install_root"
cp "$install_root/app/install/webspider-launcher.sh" "$bin_dir/webspider"
chmod 755 "$bin_dir/webspider"
printf '%s\n' "$install_root" > "${XDG_CONFIG_HOME:-$HOME/.config}/webspider/install-root"
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/webspider/install-root"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    profile="$HOME/.profile"
    marker='# WebSpider command path'
    if ! grep -F "$marker" "$profile" >/dev/null 2>&1; then
      printf '\n%s\nexport PATH="%s:$PATH"\n' "$marker" "$bin_dir" >> "$profile"
    fi
    ;;
esac

if [ "$install_service" -eq 1 ]; then
  "$bin_dir/webspider" service install --user \
    --workspace "$workspace" \
    --state-dir "$state_dir" \
    --executable "$bin_dir/webspider"
fi

if [ -d "$previous" ]; then rm -rf "$previous"; fi

echo "WebSpider $product_version installed."
echo "Command: $bin_dir/webspider"
echo "Workspace: $workspace"
if [ "$install_service" -eq 1 ]; then
  echo "Boot service: installed and running"
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if [ -s "$state_dir/hub/owner.token" ] && "$install_root/runtime/bin/node" -e \
      "fetch('http://127.0.0.1:7340/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  if [ -s "$state_dir/hub/owner.token" ]; then
    owner_token=$(sed -n '1p' "$state_dir/hub/owner.token")
    echo "Open portal: http://127.0.0.1:7340/#access_token=$owner_token"
  else
    echo "Portal is starting at http://127.0.0.1:7340"
  fi
fi
exit 0

__WEBSPIDER_ARCHIVE_BELOW__
