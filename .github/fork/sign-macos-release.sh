#!/usr/bin/env bash
# Signs the unsigned macOS app in a folder of release files with the fork's certificate, then
# rebuilds the zip the updater downloads and the manifest that carries its checksum.
# Usage: FORK_MAC_CERTIFICATE_P12=<base64> FORK_MAC_CERTIFICATE_PASSWORD=<password> sign-macos-release.sh <folder>
set -euo pipefail

assets="$(cd "$1" && pwd)"
work="$(mktemp -d)"
keychain="$work/fork-signing.keychain-db"
keychain_password="$(uuidgen)"
trap 'security delete-keychain "$keychain" 2>/dev/null || true; rm -rf "$work"' EXIT

printf '%s' "$FORK_MAC_CERTIFICATE_P12" | base64 --decode > "$work/certificate.p12"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -P "$FORK_MAC_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" > /dev/null
# codesign finds an identity only in a keychain on the search list.
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
# Nothing trusts a self-signed certificate, so it is not a "valid" identity; its hash still signs.
identity="$(security find-identity -p codesigning "$keychain" | sed -n 's/^ *1) \([0-9A-F]\{40\}\) .*/\1/p' | head -n 1)"
[[ -n "$identity" ]] || { echo "The certificate holds no code signing identity." >&2; exit 1; }

shopt -s nullglob
zips=("$assets"/*.zip)
manifests=("$assets"/*-mac.yml)
[[ ${#zips[@]} -eq 1 && ${#manifests[@]} -eq 1 ]] || { echo "Expected one zip and one mac manifest in $assets." >&2; exit 1; }
zip="${zips[0]}"
manifest="${manifests[0]}"

ditto -x -k "$zip" "$work/app"
apps=("$work/app"/*.app)
app="${apps[0]}"
codesign --force --deep --timestamp=none --sign "$identity" --keychain "$keychain" "$app"
codesign --verify --deep --strict "$app"
# The requirement every later update has to meet: this bundle id, signed by this certificate.
codesign --display --requirements - "$app"

# The disk image and the block maps describe the unsigned app.
rm -f "$zip" "$assets"/*.dmg "$assets"/*.blockmap
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"

name="$(basename "$zip")"
sha512="$(openssl dgst -sha512 -binary "$zip" | base64 | tr -d '\n')"
size="$(stat -f%z "$zip")"
version="$(sed -n 's/^version: //p' "$manifest")"
release_date="$(sed -n 's/^releaseDate: //p' "$manifest")"
cat > "$manifest" <<MANIFEST
version: $version
files:
  - url: $name
    sha512: $sha512
    size: $size
path: $name
sha512: $sha512
releaseDate: $release_date
MANIFEST
cat "$manifest"
