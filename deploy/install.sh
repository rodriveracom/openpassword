#!/usr/bin/env bash
# OpenPassword installer. Runs ON the target Linux host, as root, against a gated release archive.
#   install.sh agent plan   --archive F --sha256 H --commit C --version V --arch A --origin URL
#   install.sh agent apply  (same options)
#   install.sh agent status
# Every subcommand prints ONE JSON object on stdout: state (ready | needs_human | failed), checks[],
# needs_human[], urls, error. Exit codes: 0 ready, 10 needs_human, 1 failed, 2 bad usage.
# The installer never builds, never downloads and never prints a secret: for the administrator
# account it returns the PATH of the setup-code file, not its content. apply is idempotent: rerunning
# the installed version changes nothing. The upgrade sequence the external council is porting
# (disposable-vault preflight, drain, interrupted-activation recovery) plugs into the marked seams.
set -euo pipefail
umask 022

PREFIX=${OPENPASSWORD_PREFIX:-/opt/openpassword}
UNITS=${OPENPASSWORD_UNITS_DIR:-/etc/systemd/system}
STATE=${OPENPASSWORD_STATE_DIR:-/var/lib/openpassword}
SYSTEMCTL=${OPENPASSWORD_SYSTEMCTL:-systemctl}
SYSTEMD_RUN=${OPENPASSWORD_SYSTEMD_RUN:-systemd-run}
CURL=${OPENPASSWORD_CURL:-curl}
NODE_PIN=${OPENPASSWORD_NODE_PIN:-v24.19.0}
BROKER_URL=${OPENPASSWORD_BROKER_URL:-http://127.0.0.1:4141}
WEB_URL=${OPENPASSWORD_WEB_URL:-http://127.0.0.1:3000}
READY_TRIES=${OPENPASSWORD_READY_TRIES:-30}
SERVICES=(openpassword-broker openpassword-web)

cmd=${1:-}; sub=${2:-}
[ "$cmd" = agent ] && [[ "$sub" =~ ^(plan|apply|status)$ ]] || { echo '{"state":"failed","error":{"code":"usage","message":"usage: install.sh agent plan|apply|status [options]"}}'; exit 2; }
shift 2
ARCHIVE= SHA256= COMMIT= VERSION= ARCH= ORIGIN=
while [ $# -gt 0 ]; do
  case $1 in
    --archive) ARCHIVE=${2:-}; shift 2 ;;
    --sha256) SHA256=${2:-}; shift 2 ;;
    --commit) COMMIT=${2:-}; shift 2 ;;
    --version) VERSION=${2:-}; shift 2 ;;
    --arch) ARCH=${2:-}; shift 2 ;;
    --origin) ORIGIN=${2:-}; shift 2 ;;
    *) echo '{"state":"failed","error":{"code":"usage","message":"unknown option"}}'; exit 2 ;;
  esac
done

# ---- JSON output -------------------------------------------------------------------------------
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' | tr '\n' ' '; }
CHECKS=() HUMAN=()
check() { CHECKS+=("{\"name\":\"$(esc "$1")\",\"status\":\"$2\",\"detail\":\"$(esc "${3:-}")\"}"); }
human() { HUMAN+=("{\"step\":\"$(esc "$1")\",\"where\":\"$(esc "$2")\",\"instructions\":\"$(esc "$3")\"}"); }
join() { local IFS=,; echo "$*"; }
finish() { # state code message
  local state=$1 code=${2:-} msg=${3:-} err=null
  [ -n "$code" ] && err="{\"code\":\"$(esc "$code")\",\"message\":\"$(esc "$msg")\"}"
  printf '{"state":"%s","version":"%s","checks":[%s],"needs_human":[%s],"urls":{"console":"%s"},"error":%s}\n' \
    "$state" "$(esc "$VERSION")" "$(join "${CHECKS[@]+"${CHECKS[@]}"}")" "$(join "${HUMAN[@]+"${HUMAN[@]}"}")" "$(esc "$ORIGIN")" "$err"
  case $state in ready) exit 0 ;; needs_human) exit 10 ;; *) exit 1 ;; esac
}
fail() { check "$1" fail "$3"; finish failed "$2" "$3"; }

# ---- inputs and host ---------------------------------------------------------------------------
validate_inputs() {
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail inputs bad_version "--version must look like 0.3.0"
  [[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || fail inputs bad_sha256 "--sha256 must be 64 lowercase hex characters"
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail inputs bad_commit "--commit must be a 40 character commit id"
  [[ "$ARCH" =~ ^[a-z0-9_]+$ ]] || fail inputs bad_arch "--arch is missing or malformed"
  [[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || fail inputs bad_origin "--origin must be an https origin without a path or port"
  [ -f "$ARCHIVE" ] || fail inputs no_archive "the archive file was not found"
  check inputs ok "version, digest, commit, arch, origin and archive given"
}
check_host() {
  [ "$(uname -s)" = Linux ] || fail host not_linux "this installer runs on Linux"
  local m; case "$(uname -m)" in aarch64|arm64) m=arm64 ;; x86_64) m=x64 ;; *) m=$(uname -m) ;; esac
  [ "$m" = "$ARCH" ] || fail host arch_mismatch "the archive is $ARCH but this host is $m"
  [ "$sub" = plan ] || [ "${OPENPASSWORD_ALLOW_NONROOT:-}" = 1 ] || [ "$(id -u)" = 0 ] || fail host not_root "run as root"
  command -v "$SYSTEMCTL" >/dev/null || fail host no_systemd "systemctl was not found"
  check host ok "linux $m, root, systemd present"
}
current_version() {
  [ -L "$PREFIX/current" ] || return 1
  local t; t=$(readlink "$PREFIX/current"); printf '%s\n' "${t##*/}"
}

# ---- steps; the marked seams are where the council's upgrade sequence plugs in ------------------
step_stage() {
  STAGE=$(mktemp -d "$PREFIX/.stage-XXXXXX"); chmod 700 "$STAGE"
  cp -- "$ARCHIVE" "$STAGE/release.tar.gz"
  local got; got=$(sha256sum "$STAGE/release.tar.gz" | cut -d' ' -f1)
  [ "$got" = "$SHA256" ] || fail archive digest_mismatch "the staged archive digest does not match --sha256"
  check archive ok "staged copy matches the trusted digest"
  NEW=$(mktemp -d "$PREFIX/releases/.new-XXXXXX")
  tar -xzf "$STAGE/release.tar.gz" -C "$NEW" --no-same-owner
  chmod 755 "$NEW"
}
step_verify() {
  local f
  for f in server/main.ts node_modules/next/dist/bin/next packages/cli/dist/index.js .next/BUILD_ID node_modules/tsx/package.json node/bin/node RELEASE.json deploy/systemd/openpassword-broker.service deploy/systemd/openpassword-web.service; do
    [ -f "$NEW/$f" ] || fail release missing_file "the release lacks $f"
  done
  SD=("$SYSTEMD_RUN" --quiet --pipe --wait --property=WorkingDirectory="$NEW" -p DynamicUser=yes -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes)
  local id
  id=$("${SD[@]}" "$NEW/node/bin/node" -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1] + "/RELEASE.json", "utf8"))
const [v, a, c] = process.argv.slice(2)
console.log(r.name === "openpassword" && r.platform === "linux" && r.version === v && r.arch === a && r.commit === c ? "match" : "mismatch")
' "$NEW" "$VERSION" "$ARCH" "$COMMIT") || fail release probe_failed "the release could not be read under the unit sandbox"
  [ "$id" = match ] || fail release identity_mismatch "RELEASE.json does not match the requested version, arch and commit"
  local v; v=$("${SD[@]}" "$NEW/node/bin/node" -p process.version) || fail release probe_failed "the bundled Node did not run"
  [ "$v" = "$NODE_PIN" ] || fail release wrong_node "the bundled Node is $v, not $NODE_PIN"
  "${SD[@]}" "$NEW/node/bin/node" --import tsx -e 'require("fs").accessSync("server/main.ts", require("fs").constants.R_OK)' >/dev/null \
    || fail release broker_probe "the broker loader or entry point is not usable under the unit sandbox"
  "${SD[@]}" "$NEW/node/bin/node" node_modules/next/dist/bin/next --version >/dev/null \
    || fail release web_probe "the web launcher is not usable under the unit sandbox"
  check release ok "identity, bundled Node and both launchers verified under the unit sandbox"
}
step_preflight() { check preflight skipped "disposable-vault preflight is not implemented yet (seam for the council's port)"; }
step_drain() { check drain skipped "request drain is not implemented yet (seam for the council's port)"; }
step_switch() {
  PREV=$(readlink "$PREFIX/current" 2>/dev/null || true)
  rm -rf "$PREFIX/units-prev"; mkdir -p "$PREFIX/units-prev"
  local s
  for s in "${SERVICES[@]}"; do [ -f "$UNITS/$s.service" ] && cp -p "$UNITS/$s.service" "$PREFIX/units-prev/"; done
  [ -e "$PREFIX/releases/$VERSION" ] && fail switch exists "releases/$VERSION already exists but is not the active release"
  mv -T "$NEW" "$PREFIX/releases/$VERSION"; NEW=
  ln -sfn "releases/$VERSION" "$PREFIX/current.new"
  mv -T "$PREFIX/current.new" "$PREFIX/current"
  for s in "${SERVICES[@]}"; do install -m 0644 "$PREFIX/current/deploy/systemd/$s.service" "$UNITS/$s.service"; done
  mkdir -p "$UNITS/openpassword-broker.service.d"
  printf '[Service]\nEnvironment=OPENPASSWORD_WEB_ORIGIN=%s\n' "$ORIGIN" > "$UNITS/openpassword-broker.service.d/origin.conf"
  check switch ok "release $VERSION is current; units and origin drop-in installed"
}
restart_all() {
  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" stop openpassword-web openpassword-broker 2>/dev/null || true
  "$SYSTEMCTL" enable "${SERVICES[@]}" >/dev/null 2>&1 || true
  "$SYSTEMCTL" start openpassword-broker && "$SYSTEMCTL" start openpassword-web
}
ready() { # both services answer
  local i
  for ((i = 0; i < READY_TRIES; i++)); do
    if "$CURL" -fsS --max-time 5 "$BROKER_URL/health" >/dev/null 2>&1 && "$CURL" -fsS --max-time 5 "$WEB_URL/" >/dev/null 2>&1; then return 0; fi
    sleep "${OPENPASSWORD_READY_SLEEP:-1}"
  done
  return 1
}
step_readiness() {
  restart_all || return 1
  ready
}
step_rollback() {
  local s
  [ -n "${PREV:-}" ] || return 1
  ln -sfn "$PREV" "$PREFIX/current.new"; mv -T "$PREFIX/current.new" "$PREFIX/current"
  for s in "${SERVICES[@]}"; do [ -f "$PREFIX/units-prev/$s.service" ] && install -m 0644 "$PREFIX/units-prev/$s.service" "$UNITS/$s.service"; done
  restart_all && ready
}
human_steps() {
  human admin_account "$STATE/operator.token" "Read the setup code from this file on the server (do not paste it anywhere else) and enter it in the console at $ORIGIN to create the administrator account."
  human sign_in_providers "$ORIGIN/api/oauth/google/callback" "To use Google sign-in, create the OAuth application at the provider with this callback URL, then configure it in the console."
}

# ---- subcommands -------------------------------------------------------------------------------
status_cmd() {
  local v; v=$(current_version) || fail status not_installed "no release is installed"
  VERSION=$v
  local s
  for s in "${SERVICES[@]}"; do "$SYSTEMCTL" is-active --quiet "$s" && check "$s" ok active || fail "$s" inactive "$s is not active"; done
  ready || fail health unhealthy "the broker or console did not answer"
  check health ok "broker and console answer"
  finish ready
}
plan_cmd() {
  validate_inputs; check_host
  local cur; cur=$(current_version || true)
  if [ "$cur" = "$VERSION" ]; then check plan ok "release $VERSION is already installed; apply changes nothing"; else check plan ok "apply would install $VERSION (current: ${cur:-none})"; fi
  finish ready
}
apply_cmd() {
  validate_inputs; check_host
  local cur; cur=$(current_version || true)
  if [ "$cur" = "$VERSION" ]; then
    check apply ok "release $VERSION is already installed"
    ready || fail health unhealthy "release $VERSION is installed but the services do not answer"
    check health ok "broker and console answer"
    finish ready
  fi
  mkdir -p "$PREFIX/releases"; chmod 755 "$PREFIX"
  STAGE= NEW= PREV=
  trap '[ -n "$STAGE" ] && rm -rf "$STAGE"; [ -n "$NEW" ] && rm -rf "$NEW"' EXIT
  step_stage; step_verify; step_preflight; step_drain; step_switch
  if step_readiness; then
    check readiness ok "broker and console answer"
    if [ -z "$PREV" ]; then human_steps; finish needs_human; fi
    finish ready
  fi
  check readiness fail "the services did not become ready"
  if step_rollback; then check rollback ok "the previous release is running again"; finish failed readiness_failed "release $VERSION failed readiness; rolled back"; fi
  check rollback fail "rollback did not complete"
  finish failed rollback_failed "release $VERSION failed readiness and the rollback failed; inspect the host"
}
"${sub}_cmd"
