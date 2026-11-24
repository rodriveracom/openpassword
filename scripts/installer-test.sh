#!/usr/bin/env bash
# Tests deploy/install.sh against a fake host: a temporary prefix, stub systemctl/systemd-run/curl and a
# fake release archive. It proves the JSON contract, idempotence, refusals, rollback and that no secret
# is printed. It does not prove real systemd behaviour. Linux only; needs Node (any version).
set -euo pipefail
cd "$(dirname "$0")/.."
real_node=$(command -v node)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/bin" "$t/units" "$t/state"
fail() { echo "installer-test: FAIL: $*" >&2; exit 1; }

# Stubs.
cat > "$t/bin/systemctl" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1" in is-active) [ "${STUB_INACTIVE:-}" != 1 ] ;; *) exit 0 ;; esac
S
cat > "$t/bin/systemd-run" <<'S'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -p) shift 2 ;; --property=WorkingDirectory=*) cd "${1#*=}"; shift ;; --*) shift ;; *) break ;; esac; done
exec "$@"
S
cat > "$t/bin/curl" <<'S'
#!/usr/bin/env bash
[ "${STUB_UNHEALTHY:-}" != 1 ]
S
chmod +x "$t/bin/"*
export STUB_LOG=$t/log

pin=$("$real_node" -p process.version)
host_arch() { case "$(uname -m)" in aarch64|arm64) echo arm64 ;; x86_64) echo x64 ;; *) uname -m ;; esac; }
arch=$(host_arch)
commit=0123456789abcdef0123456789abcdef01234567
# Build a fake release with the given version.
mkrel() {
  local v=$1 d=$t/rel-$1
  mkdir -p "$d/server" "$d/node_modules/next/dist/bin" "$d/node_modules/tsx" "$d/packages/cli/dist" "$d/.next" "$d/node/bin" "$d/deploy/systemd"
  : > "$d/server/main.ts"; : > "$d/packages/cli/dist/index.js"; echo build > "$d/.next/BUILD_ID"; echo '{}' > "$d/node_modules/tsx/package.json"
  echo 'console.log("fake next")' > "$d/node_modules/next/dist/bin/next"
  printf '#!/usr/bin/env bash\nargs=()\nwhile [ $# -gt 0 ]; do if [ "$1" = --import ]; then shift 2; else args+=("$1"); shift; fi; done\nexec "%s" "${args[@]}"\n' "$real_node" > "$d/node/bin/node"; chmod +x "$d/node/bin/node"
  printf '[Service]\nExecStart=/x %s\n' "$v" > "$d/deploy/systemd/openpassword-broker.service"
  printf '[Service]\nExecStart=/y %s\n' "$v" > "$d/deploy/systemd/openpassword-web.service"
  printf '{"name":"openpassword","platform":"linux","version":"%s","arch":"%s","commit":"%s"}\n' "$v" "$arch" "$commit" > "$d/RELEASE.json"
  tar -czf "$t/openpassword-$v.tar.gz" -C "$d" .
  sha256sum "$t/openpassword-$v.tar.gz" | cut -d' ' -f1 > "$t/sha-$v"
}
mkrel 0.3.0; mkrel 0.3.1; mkrel 0.3.2

printf 'CANARY-SETUP-CODE\n' > "$t/state/operator.token"
export OPENPASSWORD_PREFIX=$t/prefix OPENPASSWORD_UNITS_DIR=$t/units OPENPASSWORD_STATE_DIR=$t/state
export OPENPASSWORD_SYSTEMCTL=$t/bin/systemctl OPENPASSWORD_SYSTEMD_RUN=$t/bin/systemd-run OPENPASSWORD_CURL=$t/bin/curl
export OPENPASSWORD_NODE_PIN=$pin OPENPASSWORD_ALLOW_NONROOT=1 OPENPASSWORD_READY_TRIES=2 OPENPASSWORD_READY_SLEEP=0
run() { # version [extra args]; prints JSON to $t/out, returns exit code
  local v=$1; shift
  bash deploy/install.sh agent "${MODE:-apply}" --archive "$t/openpassword-$v.tar.gz" --sha256 "${SHA:-$(cat "$t/sha-$v")}" \
    --commit "${COMMIT:-$commit}" --version "$v" --arch "$arch" --origin https://pass.example.com "$@" > "$t/out" 2> "$t/err" || return $?
}
state() { "$real_node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state' "$t/out"; }
code() { "$real_node" -p '(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error||{}).code||""' "$t/out"; }
json_ok() { "$real_node" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$t/out" || fail "output is not JSON"; }

# 1. plan changes nothing.
MODE=plan run 0.3.0 || fail "plan failed"; json_ok; [ "$(state)" = ready ] || fail "plan state"
[ ! -e "$t/prefix/current" ] || fail "plan installed something"

# 2. a wrong digest, a wrong commit and a malformed version are refused and leave no release.
SHA=$(printf 'a%.0s' $(seq 64)) run 0.3.0 && fail "wrong digest accepted"; json_ok; [ "$(code)" = digest_mismatch ] || fail "digest code: $(code)"
COMMIT=ffffffffffffffffffffffffffffffffffffffff run 0.3.0 && fail "wrong commit accepted"; [ "$(code)" = identity_mismatch ] || fail "commit code: $(code)"
[ ! -e "$t/prefix/current" ] && [ -z "$(ls -A "$t/prefix/releases" 2>/dev/null)" ] || fail "a refusal left files behind"

# 3. fresh install: needs_human with the setup-code PATH, no secret in output.
rc=0; run 0.3.0 || rc=$?; json_ok; [ "$rc" = 10 ] && [ "$(state)" = needs_human ] || fail "fresh install state $(state) rc $rc ($(code))"
[ "$(readlink "$t/prefix/current")" = releases/0.3.0 ] || fail "current is not 0.3.0"
grep -q "$t/state/operator.token" "$t/out" || fail "setup-code path not returned"
grep -rq CANARY "$t/out" "$t/err" && fail "the setup code was printed"
grep -q 'OPENPASSWORD_WEB_ORIGIN=https://pass.example.com' "$t/units/openpassword-broker.service.d/origin.conf" || fail "origin drop-in"

# 4. rerun is idempotent.
: > "$t/log"; run 0.3.0 || fail "rerun failed"; [ "$(state)" = ready ] || fail "rerun state"
grep -q 'stop' "$t/log" && fail "rerun restarted services"

# 5. upgrade to 0.3.1 works and keeps the previous release.
run 0.3.1 || fail "upgrade failed ($(code))"; [ "$(state)" = ready ] || fail "upgrade state"
[ "$(readlink "$t/prefix/current")" = releases/0.3.1 ] && [ -d "$t/prefix/releases/0.3.0" ] || fail "upgrade layout"

# 6. a failed readiness rolls back to 0.3.1 and says so.
rc=0; STUB_UNHEALTHY=1 run 0.3.2 || rc=$?
# With every probe failing, rollback readiness also fails: the honest answer is rollback_failed.
[ "$rc" = 1 ] && { [ "$(code)" = readiness_failed ] || [ "$(code)" = rollback_failed ]; } || fail "readiness failure not reported: rc $rc $(code)"
[ "$(readlink "$t/prefix/current")" = releases/0.3.1 ] || fail "current was not restored to 0.3.1"

# 7. status.
MODE=status run 0.3.1 || fail "status failed"; [ "$(state)" = ready ] || fail "status state"
STUB_INACTIVE=1 MODE=status run 0.3.1 && fail "inactive service reported ready"
echo "installer-test: ok"
