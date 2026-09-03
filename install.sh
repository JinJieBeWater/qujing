#!/bin/sh
set -eu

repo="JinJieBeWater/qujing"
install_dir="${QUJING_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target="darwin-arm64" ;;
  Linux:x86_64|Linux:amd64) target="linux-x64" ;;
  *) echo "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }

version="${QUJING_VERSION:-}"
if [ -z "$version" ]; then
  version=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
  version=${version##*/}
fi
case "$version" in v*) ;; *) version="v$version" ;; esac

asset="qujing-$version-$target.tar.gz"
base="https://github.com/$repo/releases/download/$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; rm -f "$install_dir/.qj.$$" "$install_dir/.qujing-transport.$$"' EXIT HUP INT TERM

curl -fL --retry 3 -o "$tmp/$asset" "$base/$asset"
curl -fL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || { echo "Missing checksum for $asset" >&2; exit 1; }
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$actual" = "$expected" ] || { echo "Checksum mismatch for $asset" >&2; exit 1; }

tar -xzf "$tmp/$asset" -C "$tmp"
bundle="$tmp/qujing-${version#v}-$target"
mkdir -p "$install_dir"
install -m 0755 "$bundle/qj" "$install_dir/.qj.$$"
install -m 0755 "$bundle/qujing-transport" "$install_dir/.qujing-transport.$$"
mv -f "$install_dir/.qj.$$" "$install_dir/qj"
mv -f "$install_dir/.qujing-transport.$$" "$install_dir/qujing-transport"

echo "Installed Qujing $version to $install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to PATH, then run: qj --version" ;;
esac
