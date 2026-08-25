#!/bin/sh
set -eu

product_version=@WEBSPIDER_VERSION@
expected_target=@WEBSPIDER_TARGET@
workspace=$(pwd)
install_root=${WEBSPIDER_INSTALL_DIR:-"$HOME/.local/lib/webspider"}
bin_dir=${WEBSPIDER_BIN_DIR:-"$HOME/.local/bin"}
state_dir=${WEBSPIDER_STATE_DIR:-"${XDG_DATA_HOME:-$HOME/.local/share}/webspider"}
listen=${WEBSPIDER_LISTEN:-"127.0.0.1:7340"}
public_base_url=${WEBSPIDER_PUBLIC_BASE_URL:-}
install_service=1
node_hub=
join_token=
node_name=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace) workspace=$2; shift 2 ;;
    --install-dir) install_root=$2; shift 2 ;;
    --bin-dir) bin_dir=$2; shift 2 ;;
    --state-dir) state_dir=$2; shift 2 ;;
    --listen) listen=$2; shift 2 ;;
    --public-base-url) public_base_url=$2; shift 2 ;;
    --node) node_hub=$2; shift 2 ;;
    --token) join_token=$2; shift 2 ;;
    --name) node_name=$2; shift 2 ;;
    --no-service) install_service=0; shift ;;
    -h|--help)
      echo "Usage: sh WebSpider_Install_${product_version}.run [--workspace PATH] [--listen HOST:PORT] [--public-base-url URL] [--node HUB_URL --token JOIN_TOKEN [--name NAME]] [--no-service]"
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

if [ -n "$node_hub" ]; then
  node_state_dir="$state_dir/node"
  if [ -n "$join_token" ]; then
    if [ -s "$node_state_dir/config.json" ] && [ -s "$node_state_dir/identity.json" ]; then
      set -- node attach --hub "$node_hub" --token "$join_token" --workspace "$workspace" --state-dir "$node_state_dir"
      if [ -n "$node_name" ]; then set -- "$@" --name "$node_name"; fi
    else
      set -- node join --hub "$node_hub" --token "$join_token" --workspace "$workspace" --state-dir "$node_state_dir"
      if [ -n "$node_name" ]; then set -- "$@" --name "$node_name"; fi
    fi
    "$bin_dir/webspider" "$@"
  elif [ ! -s "$node_state_dir/config.json" ]; then
    echo "A new worker installation requires --token with the one-time join token." >&2
    exit 2
  fi
  if [ "$install_service" -eq 1 ]; then
    "$bin_dir/webspider" service install-node --user --state-dir "$node_state_dir" --executable "$bin_dir/webspider"
    attempt=0
    worker_status=
    while [ "$attempt" -lt 120 ]; do
      worker_status=$("$bin_dir/webspider" service status-node --state-dir "$node_state_dir" 2>&1 || true)
      if printf '%s\n' "$worker_status" | grep -F '"connection_state": "online"' >/dev/null 2>&1; then
        break
      fi
      attempt=$((attempt + 1))
      sleep 0.25
    done
    if ! printf '%s\n' "$worker_status" | grep -F '"connection_state": "online"' >/dev/null 2>&1; then
      echo "The worker service started but did not authenticate with the hub:" >&2
      printf '%s\n' "$worker_status" >&2
      if [ "$platform" = linux ]; then
        echo "Logs: journalctl --user -u webspider-node.service -n 100 --no-pager" >&2
      else
        echo "Logs: $node_state_dir/logs/webspider-node.error.log" >&2
      fi
      exit 1
    fi
  fi
elif [ "$install_service" -eq 1 ]; then
  set -- service install --user \
    --listen "$listen" \
    --workspace "$workspace" \
    --state-dir "$state_dir" \
    --executable "$bin_dir/webspider"
  if [ -n "$public_base_url" ]; then
    set -- "$@" --public-base-url "$public_base_url"
  fi
  "$bin_dir/webspider" "$@"
fi

if [ -d "$previous" ]; then rm -rf "$previous"; fi

echo "WebSpider $product_version installed."
echo "Command: $bin_dir/webspider"
echo "Workspace: $workspace"
if [ -n "$node_hub" ]; then
  echo "Worker hub: $node_hub"
  if [ "$install_service" -eq 1 ]; then echo "Worker service: installed and running"; fi
elif [ "$install_service" -eq 1 ]; then
  echo "Boot service: installed and running"
  listen_host=${listen%:*}
  listen_port=${listen##*:}
  health_host=$listen_host
  case "$health_host" in 0.0.0.0|::) health_host=127.0.0.1 ;; esac
  attempt=0
  hub_ready=0
  while [ "$attempt" -lt 60 ]; do
    if [ -s "$state_dir/hub/owner.token" ] && WEBSPIDER_EXPECTED_VERSION="$product_version" "$install_root/runtime/bin/node" -e \
      "fetch('http://$health_host:$listen_port/healthz').then(async r=>{const x=await r.json();process.exit(r.ok&&x.version===process.env.WEBSPIDER_EXPECTED_VERSION?0:1)}).catch(()=>process.exit(1))"; then
      hub_ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.25
  done
  if [ "$hub_ready" -ne 1 ]; then
    echo "The hub service did not start WebSpider $product_version." >&2
    if [ "$platform" = linux ]; then
      echo "Logs: journalctl --user -u webspider.service -n 100 --no-pager" >&2
    else
      echo "Logs: $state_dir/logs/webspider.error.log" >&2
    fi
    exit 1
  fi
  if [ -s "$state_dir/hub/owner.token" ]; then
    owner_token=$(sed -n '1p' "$state_dir/hub/owner.token")
    if [ -n "$public_base_url" ]; then
      portal_url=${public_base_url%/}
    else
      access_host=$listen_host
      case "$access_host" in 0.0.0.0|::) access_host=$(hostname -f 2>/dev/null || hostname) ;; esac
      portal_url="http://$access_host:$listen_port"
    fi
    echo "Open portal: $portal_url"
    echo "Owner token: $owner_token"
  else
    echo "Portal is starting on $listen"
  fi
fi
exit 0

__WEBSPIDER_ARCHIVE_BELOW__
