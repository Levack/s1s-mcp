#!/bin/sh
set -eu

repository=Levack/s1s-mcp
install_dir=${S1S_INSTALL_DIR:-"$HOME/.local/bin"}
version=${S1S_VERSION:-}

fail() { printf 's1s-mcp: %s\n' "$*" >&2; exit 1; }
for command in curl tar mktemp awk; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command: $command"
done
if command -v sha256sum >/dev/null 2>&1; then
  checksum=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  checksum=shasum
else
  fail 'sha256sum or shasum is required to verify the download.'
fi
case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail 'Supported systems: Linux (glibc) and macOS.' ;;
esac
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail 'Supported architectures: x64 and ARM64.' ;;
esac
if [ "$os" = linux ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | awk '/musl/ { found=1 } END { exit !found }'; then
  fail 'The Linux binaries require glibc; musl/Alpine is not supported.'
fi

if [ -z "$version" ]; then
  release_url=$(curl --proto '=https' --tlsv1.2 -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repository/releases/latest")
  version=${release_url##*/}
fi
case "$version" in
  v[0-9]*) ;;
  *) fail 'No release found. S1S_VERSION must be a release tag such as v0.0.1.' ;;
esac
case "$version" in *[!a-zA-Z0-9._-]*) fail 'Invalid release tag.' ;; esac

temporary=$(mktemp -d)
destination=
trap 'rm -rf "$temporary"; if [ -n "$destination" ]; then rm -f "$destination"; fi' EXIT
trap 'exit 1' HUP INT TERM
asset=s1s-mcp-$os-$arch.tar.gz
base_url=https://github.com/$repository/releases/download/$version
curl --proto '=https' --tlsv1.2 -fsSL "$base_url/$asset" -o "$temporary/$asset"
curl --proto '=https' --tlsv1.2 -fsSL "$base_url/SHA256SUMS" -o "$temporary/SHA256SUMS"
expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$temporary/SHA256SUMS")
[ "${#expected}" -eq 64 ] || fail "Missing or invalid checksum for $asset."
case "$expected" in *[!a-fA-F0-9]*) fail 'Invalid SHA-256 checksum.' ;; esac
if [ "$checksum" = sha256sum ]; then
  actual=$(sha256sum "$temporary/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')
fi
[ "$expected" = "$actual" ] || fail 'Checksum mismatch; installation aborted.'
tar -xzf "$temporary/$asset" -C "$temporary" s1s-mcp
[ "$("$temporary/s1s-mcp" --version)" = "${version#v}" ] || fail 'Binary version does not match the release tag.'
mkdir -p "$install_dir"
destination=$(mktemp "$install_dir/.s1s-mcp.XXXXXX")
cp "$temporary/s1s-mcp" "$destination"
chmod 755 "$destination"
mv -f "$destination" "$install_dir/s1s-mcp"
destination=
printf 'Installed s1s-mcp %s to %s/s1s-mcp\n' "${version#v}" "$install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf 'Add it to your PATH: export PATH="%s:$PATH"\n' "$install_dir" ;;
esac
