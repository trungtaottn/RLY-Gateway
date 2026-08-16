#!/bin/sh
# RLY Gateway bootstrap installer (#129).
#
# Minimal, audited, FAIL-CLOSED POSIX-sh bootstrap for clean per-user macOS /
# Linux installs. It does NOT require a source checkout, npm, pnpm, or a
# user-provisioned Node; it does NOT require sudo (the normal per-user
# install/service contract is no-root).
#
# What it does:
#   1. Resolves the channel (stable default) + platform target + origin.
#   2. Downloads the signed channel metadata, the signed release manifest, and
#      the EXACT platform artifact (+ sha256 + Ed25519 signature) into a
#      private staging directory over TLS from the approved origin.
#   3. Verifies, BEFORE executing/installing the artifact:
#        a. the tarball sha256 equals the published `<tarball>.sha256`,
#        b. the published sha256 equals the value embedded in BOTH the signed
#           channel metadata and the signed release manifest for this target,
#        c. the artifact's Ed25519 digest statement (`<tarball>.sig` over
#           `sha256:<hex>`) verifies against the committed RLY release PUBLIC
#           key (the private key never leaves the release workflow).
#      The signed metadata JSON itself is verified (canonical-JSON Ed25519 +
#      channel evaluation) by the bundled verifier inside `rly install` —
#      the same exact bytes just authenticated above — BEFORE any install
#      mutation. Nothing installs or mutates on unverified content.
#   4. Unpacks and hands off to `rly install --artifact <tarball>
#      --metadata-dir <staging>` which performs the FULL signature chain
#      verification, installs the stable #94 bootstrap + #35 artifact layout,
#      registers the per-user service (macOS LaunchAgent / Linux systemd
#      --user, never root), and guides `rly config`.
#
# INSTALL != ACTIVATE: this script's install registers the FIRST service
# (first-install boundary). Update acquisition never changes the serving
# `active` reference; Wave 4 (`rly update`) owns activation.
#
# Logs carry channel/version/build/digest/platform/path/status metadata only.
#
# Usage:
#   sh install.sh [--channel beta|stable] [--version <v>] [--target <t>]
#                 [--origin <url>]
#   env: RLY_CHANNEL, RLY_VERSION, RLY_TARGET, RLY_ORIGIN, RLY_VERBOSE
#
# Exit codes: 0 ok; 1 verification/install failure; 2 usage; 78 unverified.

set -u

ORIGIN="${RLY_ORIGIN:-https://github.com/trungtaottn/RLY-Gateway}"
CHANNEL="${RLY_CHANNEL:-stable}"
VERSION="${RLY_VERSION:-}"
TARGET="${RLY_TARGET:-}"
VERBOSE="${RLY_VERBOSE:-0}"

# The committed release PUBLIC key (see scripts/release/signing-public-key.pem;
# sha256 fingerprint computed by `rly install` verification). The private key
# is ONLY the repository secret RLY_RELEASE_SIGNING_KEY.
RELEASE_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2B/B4lSjIq+glRCQKLlQl/MtKQqXqhr6wHyeqMPuBGo=
-----END PUBLIC KEY-----
"

say() { printf '%s\n' "$*"; }
fail() { printf 'RLY install: ERROR: %s\n' "$*" >&2; exit 1; }
die_usage() { printf 'RLY install: usage: sh install.sh [--channel beta|stable] [--version <v>] [--target <t>] [--origin <url>]\n' >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel)
      [ "$#" -ge 2 ] || die_usage
      CHANNEL="$2"; shift 2 ;;
    --version)
      [ "$#" -ge 2 ] || die_usage
      VERSION="$2"; shift 2 ;;
    --target)
      [ "$#" -ge 2 ] || die_usage
      TARGET="$2"; shift 2 ;;
    --origin)
      [ "$#" -ge 2 ] || die_usage
      ORIGIN="$2"; shift 2 ;;
    *)
      die_usage ;;
  esac
done

case "$CHANNEL" in
  beta|stable) : ;;
  *) fail "channel must be beta or stable (got '$CHANNEL')" ;;
esac

# --- platform target resolution (#35/#128 promoted matrix) ----------------
if [ -z "$TARGET" ]; then
  OS="$(uname -s 2>/dev/null || true)"
  ARCH="$(uname -m 2>/dev/null || true)"
  case "$OS" in
    Darwin)
      case "$ARCH" in
        arm64) TARGET="darwin-arm64" ;;
        x86_64) TARGET="darwin-x64" ;;
        *) fail "unsupported macOS architecture '$ARCH'; RLY supports darwin-arm64 and darwin-x64" ;;
      esac ;;
    Linux)
      case "$ARCH" in
        x86_64) TARGET="linux-x64" ;;
        aarch64) TARGET="linux-arm64" ;;
        *) fail "unsupported Linux architecture '$ARCH'; RLY supports linux-x64 and linux-arm64" ;;
      esac ;;
    *)
      fail "unsupported OS '$OS'; RLY supports macOS and Linux only" ;;
  esac
fi
case "$TARGET" in
  darwin-arm64|darwin-x64|linux-x64|linux-arm64) : ;;
  *) fail "unsupported target '$TARGET'; RLY publishes darwin-arm64, darwin-x64, linux-x64, linux-arm64" ;;
esac

# --- required tools (all standard on clean macOS/Linux; no Node/npm/pnpm) --
for tool in curl shasum tar; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' is missing; install it and re-run"
done
# Ed25519 verification requires an OpenSSL 3.x/1.1.1 `pkeyutl -rawin` (macOS
# LibreSSL does not support it): FAIL CLOSED with an actionable message rather
# than executing unverified content.
if ! openssl pkeyutl -help >/dev/null 2>&1; then
  fail "openssl is missing; install OpenSSL 3.x (macOS: brew install openssl@3) to verify the artifact signature"
fi

# --- staging (private) -----------------------------------------------------
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/rly-install.XXXXXX")" || fail "cannot create staging directory"
chmod 700 "$STAGING"
trap 'rm -rf "$STAGING"' EXIT

KEY_FILE="$STAGING/rly-public-key.pem"
if [ -n "${RLY_RELEASE_PUBLIC_KEY_FILE:-}" ]; then
  # Operator/mirror override: a downstream origin that signs with its own key
  # must provide that PUBLIC key file explicitly. The default is always the
  # committed RLY release public key. This is a trust-anchor choice, never a
  # secret.
  cp "$RLY_RELEASE_PUBLIC_KEY_FILE" "$KEY_FILE" || fail "cannot read RLY_RELEASE_PUBLIC_KEY_FILE"
else
  printf '%s\n' "$RELEASE_PUBLIC_KEY_PEM" > "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"

# --- resolve release + download (metadata separated from artifacts, #128) --
if [ -n "$VERSION" ]; then
  RELEASE_VERSION="$VERSION"
else
  # Newest release for the channel: GitHub API listing is ONLY a discovery
  # hint; trust comes from the signed metadata + evaluation inside rly.
  say "RLY install: resolving newest $CHANNEL release..."
  case "$ORIGIN" in
    https://github.com/*)
      API_OWNER_REPO="$(printf '%s' "$ORIGIN" | sed -E 's#^https://github\.com/##; s#/$##')"
      API_URL="https://api.github.com/repos/$API_OWNER_REPO/releases?per_page=100"
      ;;
    *)
      # Non-GitHub origin (mirror/test): same discovery contract served by
      # the origin itself; signature verification is still the trust anchor.
      API_URL="$ORIGIN/releases?per_page=100"
      ;;
  esac
  RELEASE_VERSION="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API_URL" 2>/dev/null \
    | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"v[^"]*"' | sed -E 's/.*"v//; s/"$//' \
    | { while read -r tag; do
        case "$CHANNEL" in
          beta) case "$tag" in *-beta.*) printf '%s\n' "$tag"; break ;; esac ;;
          stable) case "$tag" in *-beta.*) : ;; *) printf '%s\n' "$tag"; break ;; esac ;;
        esac
      done; } )" || true
  [ -n "$RELEASE_VERSION" ] || fail "no $CHANNEL release found on $ORIGIN"
fi
say "RLY install: release $RELEASE_VERSION ($CHANNEL, target $TARGET)"

fetch() { # fetch <asset>
  curl -fsSL --retry 3 --connect-timeout 20 "$ORIGIN/releases/download/v$RELEASE_VERSION/$1" -o "$STAGING/$1" \
    || fail "download failed for $1"
}

CHANNEL_JSON="rly-channel-$CHANNEL.json"
MANIFEST_JSON="rly-release.json"
fetch "$CHANNEL_JSON"
fetch "$CHANNEL_JSON.sig"
fetch "$MANIFEST_JSON"
fetch "$MANIFEST_JSON.sig"

# The artifact filename for this target comes from the signed release
# manifest (published by the release workflow). Minimal JSON extraction of
# OUR OWN fixed manifest shape; any failure fails closed.
ARTIFACT="$(awk -v want="$TARGET" '
  function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
  /^[[:space:]]*"target"[[:space:]]*:/ {
    line = trim($0)
    if (index(line, "\"target\": \"" want "\"") > 0) { in_target = 1; next }
  }
  in_target && /^[[:space:]]*"filename"[[:space:]]*:/ {
    line = trim($0)
    pos = index(line, "\"filename\": \"")
    if (pos > 0) { name = substr(line, pos + length("\"filename\": \"")); gsub(/".*/, "", name); print name; exit }
  }
  in_target && /^[[:space:]]*\}/ { exit }
' "$STAGING/$MANIFEST_JSON")"
[ -n "$ARTIFACT" ] || fail "release manifest for $TARGET does not name an artifact (stale or wrong-target metadata)"

fetch "$ARTIFACT"
fetch "$ARTIFACT.sha256"
fetch "$ARTIFACT.sig"

# --- verification BEFORE executing/installing ------------------------------
SHA256_FILE="$(awk '{print $1}' "$STAGING/$ARTIFACT.sha256" 2>/dev/null | head -n 1)"
ACTUAL_SHA256="$(shasum -a 256 "$STAGING/$ARTIFACT" | awk '{print $1}')"
[ -n "$SHA256_FILE" ] || fail "published sha256 file for $ARTIFACT is missing/empty"
[ "$ACTUAL_SHA256" = "$SHA256_FILE" ] || fail "artifact digest mismatch: downloaded $ARTIFACT sha256=$ACTUAL_SHA256 != published $SHA256_FILE; refusing to install"

# Cross-check the digest against BOTH signed metadata documents (the exact
# byte authority the release workflow published).
manifest_sha256() {
  awk -v want="$TARGET" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^[[:space:]]*"target"[[:space:]]*:/ {
      line = trim($0)
      if (index(line, "\"target\": \"" want "\"") > 0) { in_target = 1; next }
    }
    in_target && /^[[:space:]]*"sha256"[[:space:]]*:/ {
      line = trim($0)
      pos = index(line, "\"sha256\": \"")
      if (pos > 0) { hex = substr(line, pos + length("\"sha256\": \""), 64); if (hex ~ /^[0-9a-f]{64}$/) { print hex; exit } }
    }
    in_target && /^[[:space:]]*\}/ { exit }
  ' "$1"
}
channel_sha256() {
  awk -v want="$TARGET" '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^[[:space:]]*\"/ {
      line = trim($0)
      if (index(line, "\"" want "\": {") > 0) { in_target = 1; next }
    }
    in_target && /^[[:space:]]*"sha256"[[:space:]]*:/ {
      line = trim($0)
      pos = index(line, "\"sha256\": \"")
      if (pos > 0) { hex = substr(line, pos + length("\"sha256\": \""), 64); if (hex ~ /^[0-9a-f]{64}$/) { print hex; exit } }
    }
    in_target && /^[[:space:]]*\}/ { in_target = 0 }
  ' "$1"
}
MANIFEST_SHA256="$(manifest_sha256 "$STAGING/$MANIFEST_JSON")"
CHANNEL_SHA256="$(channel_sha256 "$STAGING/$CHANNEL_JSON")"
[ -n "$MANIFEST_SHA256" ] || fail "could not extract the $TARGET digest from the release manifest; refusing (stale or malformed metadata)"
[ -n "$CHANNEL_SHA256" ] || fail "could not extract the $TARGET digest from the channel metadata; refusing (stale or malformed metadata)"
[ "$ACTUAL_SHA256" = "$MANIFEST_SHA256" ] || fail "artifact digest does not match the release manifest ($ACTUAL_SHA256 != $MANIFEST_SHA256); refusing"
[ "$ACTUAL_SHA256" = "$CHANNEL_SHA256" ] || fail "artifact digest does not match the channel metadata ($ACTUAL_SHA256 != $CHANNEL_SHA256); refusing"

# Ed25519 digest-statement verification against the committed public key.
SIG_B64="$(awk '
  /^[[:space:]]*"signature"[[:space:]]*:/ {
    line = $0
    gsub(/^[ \t]*"signature"[ \t]*:[ \t]*"/, "", line)
    gsub(/".*$/, "", line)
    print line
    exit
  }
' "$STAGING/$ARTIFACT.sig")"
[ -n "$SIG_B64" ] || fail "artifact signature envelope $ARTIFACT.sig carries no signature; refusing"
printf 'sha256:%s\n' "$ACTUAL_SHA256" > "$STAGING/digest.txt"
# Single-line base64 decode (OpenSSL needs -A; base64 -d/-D are the macOS/GNU CLIs).
if ! printf '%s' "$SIG_B64" | openssl base64 -d -A > "$STAGING/sig.bin" 2>/dev/null \
  && ! printf '%s' "$SIG_B64" | base64 -d > "$STAGING/sig.bin" 2>/dev/null \
  && ! printf '%s' "$SIG_B64" | base64 -D > "$STAGING/sig.bin" 2>/dev/null; then
  fail "artifact signature is not valid base64"
fi
if [ ! -s "$STAGING/sig.bin" ]; then
  fail "artifact signature decoded to zero bytes; refusing"
fi
if ! openssl pkeyutl -verify -pubin -inkey "$KEY_FILE" -rawin -in "$STAGING/digest.txt" -sigfile "$STAGING/sig.bin" >/dev/null 2>&1; then
  fail "artifact Ed25519 signature does NOT verify against the RLY release public key; refusing to execute/install unverified content"
fi
say "RLY install: artifact verified (sha256 $ACTUAL_SHA256, signature ok)"

# --- unpack + full signature-chain verification + install ------------------
UNPACKED="$STAGING/unpacked"
mkdir -p "$UNPACKED"
tar -xzf "$STAGING/$ARTIFACT" -C "$UNPACKED" || fail "cannot unpack $ARTIFACT"
RLY_BIN="$UNPACKED/rly"
[ -x "$RLY_BIN" ] || fail "the verified artifact does not contain an executable rly launcher"
if [ "$VERBOSE" = "1" ]; then
  "$RLY_BIN" install --artifact "$STAGING/$ARTIFACT" --metadata-dir "$STAGING" --channel "$CHANNEL" --target "$TARGET" ${VERSION:+--version "$VERSION"} || exit $?
else
  "$RLY_BIN" install --artifact "$STAGING/$ARTIFACT" --metadata-dir "$STAGING" --channel "$CHANNEL" --target "$TARGET" ${VERSION:+--version "$VERSION"} 2>&1 || exit $?
fi
