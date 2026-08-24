#!/bin/sh
set -eu

config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
root_file="$config_home/webspider/install-root"
if [ ! -r "$root_file" ]; then
  echo "WebSpider installation metadata is missing. Re-run the installer." >&2
  exit 1
fi
install_root=$(sed -n '1p' "$root_file")
if [ ! -x "$install_root/runtime/bin/node" ]; then
  echo "WebSpider's bundled runtime is missing. Re-run the installer." >&2
  exit 1
fi
export PATH="$install_root/runtime/bin:$PATH"
export WEBSPIDER_EXECUTABLE="$0"
exec "$install_root/runtime/bin/node" "$install_root/app/bin/webspider.js" "$@"
