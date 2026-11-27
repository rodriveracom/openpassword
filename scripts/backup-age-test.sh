#!/usr/bin/env bash
# Tests the operator-held-key backup: backup.sh --encrypt --direct on the host side, restore-encrypted.sh on the operator
# side. Linux; needs age (age-keygen), tar, Node 24 and a tmpfs at /dev/shm. Fails, not skips, when one is missing.
# Uses a throwaway key and a throwaway vault only. The systemd (root) path is tested by scripts/backup-age-systemd-test.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "backup-age-test: FAIL: $*" >&2; exit 1; }
command -v age >/dev/null && command -v age-keygen >/dev/null || fail "age and age-keygen are required"
[ "$(stat -f -c %T /dev/shm 2>/dev/null)" = tmpfs ] || fail "a tmpfs at /dev/shm is required"
node_bin=$(command -v node)
t=$(mktemp -d); shm=$(mktemp -d /dev/shm/op-backup-age.XXXXXXXX)
trap 'rm -rf -- "${t:?}" "${shm:?}"' EXIT
mkdir -m 0700 "$t/data" "$shm/stage"
printf 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n' > "$t/swaps"   # no swap
cat > "$t/seed.mjs" <<'JS'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2] + '/vault.sqlite')
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('sealed-value')")
db.close()
JS
cat > "$t/read.mjs" <<'JS'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2] + '/vault.sqlite', { readOnly: true })
console.log(db.prepare('SELECT a FROM t').get().a)
JS
"$node_bin" --import tsx scripts/backup-human-fixture.ts seed "$t/data" "$t/recovery-fixture"
"$node_bin" "$t/seed.mjs" "$t/data"
age-keygen -o "$t/id.txt" >/dev/null 2>&1; chmod 600 "$t/id.txt"
age-keygen -y "$t/id.txt" > "$t/recipient"
# The copy under test carries a .test-seams file, which turns on the test substitutes. The real directory never has one.
mkdir -p "$t/deploy" "$t/server" "$t/engine-bin"
cp server/engine-cli.ts "$t/server/"
cp engine-bin/ephemeral "$t/engine-bin/"
cp -R deploy/backup "$t/deploy/bk"; : > "$t/deploy/bk/.test-seams"
empty_stage() { [ -z "$(ls -A "$shm/stage")" ]; }
# Every case runs in a clean environment holding only these settings; a case's own VAR=value arguments replace them, and
# nothing set for one case reaches the next.
base_env=(PATH="$PATH" HOME="$t" OPENPASSWORD_NODE="$node_bin" OPENPASSWORD_HOME="$t/data" OPENPASSWORD_BACKUP_STAGE="$shm/stage"
  OPENPASSWORD_BACKUP_SWAPS_FILE="$t/swaps" OPENPASSWORD_BACKUP_RECIPIENT="$t/recipient")
bk() { env -i "${base_env[@]}" "$@" bash "$t/deploy/bk/backup.sh" --encrypt --direct; }
backup() { bk; }
restore() { env -i PATH="$PATH" HOME="$t" OPENPASSWORD_NODE="$node_bin" OPENPASSWORD_BACKUP_IDENTITY="$t/id.txt" bash deploy/backup/restore-encrypted.sh "$@"; }

# 1. A good run: ciphertext only, nothing readable, stage empty afterwards.
backup > "$t/out.age" || fail "encrypted backup"
[ -s "$t/out.age" ] || fail "no ciphertext was written"
if grep -qa 'sealed-value\|test-master-key\|test-token\|SQLite format' "$t/out.age"; then fail "plain text in the ciphertext"; fi
empty_stage || fail "the staged snapshot was left behind after success"

# 2. The operator side restores it and the vault checks out.
mkdir -m 0700 "$t/restored"
restore "$t/out.age" "$t/restored" >/dev/null || fail "restore"
[ "$("$node_bin" "$t/read.mjs" "$t/restored")" = sealed-value ] || fail "restored row differs"
"$node_bin" --import tsx scripts/backup-human-fixture.ts verify "$t/restored" "$t/recovery-fixture"
cmp -s "$t/data/master.key" "$t/restored/master.key" || fail "restored master.key differs"
cmp -s "$t/data/operator.token" "$t/restored/operator.token" || fail "restored operator.token differs"

# 3. Restore refusals leave the target empty: wrong key, truncated file, non-empty target, loose key permissions.
age-keygen -o "$t/other.txt" >/dev/null 2>&1; chmod 600 "$t/other.txt"
mkdir -m 0700 "$t/r2"
env -i PATH="$PATH" HOME="$t" OPENPASSWORD_NODE="$node_bin" OPENPASSWORD_BACKUP_IDENTITY="$t/other.txt" bash deploy/backup/restore-encrypted.sh "$t/out.age" "$t/r2" >/dev/null 2>&1 && fail "a wrong key was accepted"
[ -z "$(ls -A "$t/r2")" ] || fail "a wrong key left files in the target"
head -c 300 "$t/out.age" > "$t/short.age"
restore "$t/short.age" "$t/r2" >/dev/null 2>&1 && fail "a truncated file was accepted"
[ -z "$(ls -A "$t/r2")" ] || fail "a truncated file left files in the target"
restore "$t/out.age" "$t/restored" >/dev/null 2>&1 && fail "restore wrote into a non-empty directory"
chmod 644 "$t/id.txt"
restore "$t/out.age" "$t/r2" >/dev/null 2>&1 && fail "a world-readable key was accepted"
chmod 600 "$t/id.txt"

# 3b. A validly encrypted archive with unsafe or unexpected members is refused before anything is extracted.
rcp=$(cat "$t/recipient")
evil() { # name, then the commands that build the archive in $t/ev
  local name=$1; shift
  rm -rf "$t/ev"; mkdir "$t/ev"; ( cd "$t/ev" && "$@" ) || fail "could not build the $name archive"
  age -r "$rcp" -o "$t/$name.age" "$t/ev/$name.tar" || fail "could not encrypt the $name archive"
  restore "$t/$name.age" "$t/r2" >/dev/null 2>&1 && fail "the $name archive was accepted"
  [ -z "$(ls -A "$t/r2")" ] || fail "the $name archive left files in the target"
}
good() { cp "$t/data/vault.sqlite" vault.sqlite; cp "$t/data/master.key" master.key; }
evil symlink bash -c "ln -s /etc/hostname vault.sqlite; cp '$t/data/master.key' master.key; tar -cf symlink.tar vault.sqlite master.key"
evil extra bash -c "cp '$t/data/vault.sqlite' vault.sqlite; cp '$t/data/master.key' master.key; echo x > extra; tar -cf extra.tar vault.sqlite master.key extra"
evil duplicate bash -c "cp '$t/data/vault.sqlite' vault.sqlite; cp '$t/data/master.key' master.key; tar -cf duplicate.tar vault.sqlite master.key; tar -rf duplicate.tar vault.sqlite"
evil dirmember bash -c "cp '$t/data/vault.sqlite' vault.sqlite; mkdir master.key; tar -cf dirmember.tar vault.sqlite master.key"
evil nomaster bash -c "cp '$t/data/vault.sqlite' vault.sqlite; tar -cf nomaster.tar vault.sqlite"
evil traversal bash -c "cp '$t/data/vault.sqlite' vault.sqlite; cp '$t/data/master.key' master.key; tar -cf traversal.tar vault.sqlite master.key --transform='s,^master.key,../master.key,'"

# 4. The host refuses before any snapshot when the recipient file is unsuitable.
refuses() { local what=$1; shift; bk "$@" > "$t/refused.out" 2>/dev/null && fail "$what was accepted"; [ ! -s "$t/refused.out" ] || fail "$what wrote output"; empty_stage || fail "$what left a staged snapshot"; }
refuses "a missing recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/none"
cp "$t/id.txt" "$t/withsecret"
refuses "a private key in the recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/withsecret"
printf 'not-a-key\n' > "$t/junk"
refuses "junk in the recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/junk"
printf '# AGE-SECRET-KEY-1EXAMPLEEXAMPLEEXAMPLE\n%s\n' "$rcp" > "$t/commented"
refuses "a commented private key in the recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/commented"
printf '%s\nnot-a-key\n' "$rcp" > "$t/mixed"
refuses "a stray line in the recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/mixed"
: > "$t/empty"
refuses "an empty recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/empty"
cp "$t/recipient" "$t/gw"; chmod 664 "$t/gw"
refuses "a group-writable recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/gw"
ln -s "$t/recipient" "$t/link"
refuses "a symlinked recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/link"
mkdir "$t/dir"
refuses "a directory as the recipient file" OPENPASSWORD_BACKUP_RECIPIENT="$t/dir"
# Characters systemd would expand in a unit's arguments are refused in the paths it is given.
refuses "a data path containing a dollar sign" OPENPASSWORD_HOME='/tmp/a$b'
refuses "a data path containing a percent sign" OPENPASSWORD_HOME='/tmp/a%h'
# Staging must be memory-only.
if [ "$(stat -f -c %T /var/tmp 2>/dev/null)" != tmpfs ] && [ "$(stat -f -c %T /var/tmp 2>/dev/null)" != ramfs ]; then
  refuses "a staging directory on disk" OPENPASSWORD_BACKUP_STAGE=/var/tmp
fi

# 4b. The swap and mount classifier, tested on its own so no result depends on this host's swap or mount options.
swaps_with() { printf 'Filename\tType\tSize\tUsed\tPriority\n%s\n' "$1" > "$t/sw"; }
classify() { # expected exit (0 safe, 1 unsafe), description, then env assignments for the case
  local want=$1 what=$2 got=0; shift 2
  env -i PATH="$PATH" "$@" bash -c '. "$1"; swap_safe' bash "$t/deploy/bk/stage-check.sh" || got=$?
  [ "$got" = "$want" ] || fail "swap classifier: $what (wanted $want, got $got)"
}
classify 0 "no swap" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/swaps"
swaps_with '/dev/sda2 partition 1000 0 -2';  classify 1 "an unencrypted swap partition" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw"
swaps_with '/swapfile file 1000 0 -2';       classify 1 "an unencrypted swap file" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw"
classify 1 "an unreadable swap table" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/no-such-file"
swaps_with '/dev/zram0 partition 1000 0 100'
mkdir -p "$t/sys-empty/block"
classify 1 "zram whose sysfs directory is missing" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw" OPENPASSWORD_BACKUP_SYSFS="$t/sys-empty"
mkdir -p "$t/sys/block/zram0"
classify 0 "zram with no backing_dev file" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw" OPENPASSWORD_BACKUP_SYSFS="$t/sys"
printf 'none\n' > "$t/sys/block/zram0/backing_dev"
classify 0 "zram whose backing_dev is none" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw" OPENPASSWORD_BACKUP_SYSFS="$t/sys"
printf '/dev/sdb1\n' > "$t/sys/block/zram0/backing_dev"
classify 1 "zram with a writeback device" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw" OPENPASSWORD_BACKUP_SYSFS="$t/sys"
mkdir -p "$t/sys/block/dm-0/dm"; swaps_with '/dev/dm-0 partition 1000 0 -2'
printf 'CRYPT-LUKS2-0123-swap\n' > "$t/sys/block/dm-0/dm/uuid"
classify 0 "a dm-crypt swap device" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw" OPENPASSWORD_BACKUP_SYSFS="$t/sys"
printf 'LVM-abcdef\n' > "$t/sys/block/dm-0/dm/uuid"
classify 1 "a plain logical volume as swap" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw" OPENPASSWORD_BACKUP_SYSFS="$t/sys"
# tmpfs with and without noswap, with a findmnt stand-in so the host's mount options do not matter.
mkdir "$t/shim"
printf '#!/bin/sh\necho "rw,nosuid,noswap"\n' > "$t/shim/findmnt"; chmod 755 "$t/shim/findmnt"
mount_case() { # expected, description, shim output, swap table
  local want=$1 what=$2 got=0; printf '#!/bin/sh\necho "%s"\n' "$3" > "$t/shim/findmnt"
  env -i PATH="$t/shim:$PATH" OPENPASSWORD_BACKUP_SWAPS_FILE="$4" bash -c '. "$2"; memory_only "$1"' bash "$shm" "$t/deploy/bk/stage-check.sh" || got=$?
  [ "$got" = "$want" ] || fail "memory_only: $what (wanted $want, got $got)"
}
swaps_with '/dev/sda2 partition 1000 0 -2'
mount_case 0 "tmpfs mounted noswap with disk swap present" "rw,nosuid,noswap" "$t/sw"
mount_case 1 "tmpfs without noswap with disk swap present" "rw,nosuid" "$t/sw"
mount_case 0 "tmpfs without noswap and no swap" "rw,nosuid" "$t/swaps"
if [ "$(stat -f -c %T /var/tmp 2>/dev/null)" != tmpfs ] && [ "$(stat -f -c %T /var/tmp 2>/dev/null)" != ramfs ]; then
  got=0; env -i PATH="$PATH" bash -c '. "$1"; memory_only /var/tmp' bash "$t/deploy/bk/stage-check.sh" || got=$?
  [ "$got" = 1 ] || fail "memory_only accepted a directory that is not on tmpfs or ramfs"
fi

# 4c. Search permission on the zram directory: tested as an unprivileged user, because root ignores directory permissions.
share=$shm/share; mkdir -p "$share/sysfs/block/zram0"; chmod 755 "$shm" "$share" "$share/sysfs" "$share/sysfs/block"
cp "$t/deploy/bk/stage-check.sh" "$share/stage-check.sh"; : > "$share/.test-seams"
printf 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0 partition 1000 0 100\n' > "$share/swaps"
chmod 644 "$share/stage-check.sh" "$share/.test-seams" "$share/swaps"
as_other() { # run a command as an unprivileged user (root is dropped to nobody; anyone else is already unprivileged)
  if [ "$(id -u)" = 0 ]; then
    command -v setpriv >/dev/null || fail "setpriv is required to test as an unprivileged user"
    setpriv --reuid 65534 --regid 65534 --clear-groups "$@"
  else "$@"; fi
}
zram_case() { # expected, description, directory mode
  local want=$1 what=$2 got=0; chmod "$3" "$share/sysfs/block/zram0"
  as_other env -i PATH="$PATH" OPENPASSWORD_BACKUP_SWAPS_FILE="$share/swaps" OPENPASSWORD_BACKUP_SYSFS="$share/sysfs" \
    bash -c '. "$1"; swap_safe' bash "$share/stage-check.sh" || got=$?
  [ "$got" = "$want" ] || fail "zram directory permissions: $what (wanted $want, got $got)"
}
# The mode gives the same bits to the owner and to everyone else, so it holds whoever runs the test.
zram_case 0 "readable and searchable, no writeback file" 555
zram_case 1 "readable but not searchable hides backing_dev" 444
zram_case 1 "searchable but not readable" 111
chmod 755 "$share/sysfs/block/zram0"

# 4d. The test substitutes are inert without .test-seams, and through sudo no environment setting is honored.
printf '#!/bin/sh\n: > "%s/shim-ran"\ncat >/dev/null\nexit 1\n' "$t" > "$t/seam-age"; chmod 755 "$t/seam-age"
env -i "${base_env[@]}" OPENPASSWORD_BACKUP_AGE="$t/seam-age" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/swaps.disk-for-seam" \
  bash deploy/backup/backup.sh --encrypt --direct > "$t/seam.out" 2>/dev/null || true
[ ! -e "$t/shim-ran" ] || fail "the age substitute was honored without .test-seams"
printf 'Filename\tType\tSize\tUsed\tPriority\n/dev/sda2 partition 1000 0 -2\n' > "$t/sw-disk"
got=0; env -i PATH="$PATH" OPENPASSWORD_BACKUP_SWAPS_FILE="$t/sw-disk" bash -c '. deploy/backup/stage-check.sh; [ "$SWAPS" = /proc/swaps ]' || got=$?
[ "$got" = 0 ] || fail "the swap table override was honored without .test-seams"
err=$(env -i "${base_env[@]}" SUDO_USER=operator OPENPASSWORD_BACKUP_RECIPIENT="$t/recipient" bash "$t/deploy/bk/backup.sh" --encrypt --direct 2>&1 >/dev/null || true)
case "$err" in *"/etc/openpassword/backup.recipient"*|*"/opt/openpassword/current/node/bin/node"*) ;; *) fail "through sudo an environment override was honored: $err" ;; esac
[ ! -e "$t/shim-ran" ] || fail "something ran that should not have"

# 5. The staged plain snapshot is gone after a failure and after termination.
mkdir "$t/bin"
printf '#!/bin/sh\ncat >/dev/null\nexit 1\n' > "$t/bin/age"; chmod 700 "$t/bin/age"
refuses "an encryption failure" OPENPASSWORD_BACKUP_AGE="$t/bin/age"
printf '#!/bin/sh\nsleep 30\n' > "$t/bin/age"
# Terminate the whole process group, as Ctrl-C or a service stop does, without killing any child by hand.
command -v setsid >/dev/null || fail "setsid is required"
env -i "${base_env[@]}" OPENPASSWORD_BACKUP_AGE="$t/bin/age" setsid bash "$t/deploy/bk/backup.sh" --encrypt --direct > "$t/o6" 2>/dev/null &
pid=$!
for _ in $(seq 1 100); do
  [ -s "$shm/stage"/*/vault.sqlite ] 2>/dev/null && break
  sleep 0.1
done
[ -s "$shm/stage"/*/vault.sqlite ] 2>/dev/null || fail "the snapshot was not staged in time to test termination"
kill -TERM -- "-$pid"
wait "$pid" 2>/dev/null || true
sleep 0.5
empty_stage || fail "the staged snapshot was left behind after termination"

# 6. The host side needs no borg and no private key.
bk OPENPASSWORD_BACKUP_ENV=/nonexistent >/dev/null || fail "encrypt mode needs borg settings"
# 6b. The operator's one script: init, then a backup made for the key it created, then check.
op=$t/operator-keys
opbk() { env -i PATH="$PATH" HOME="$t" OPENPASSWORD_OPERATOR_KEYDIR="$op" bash deploy/backup/operator-backup.sh "$@"; }
opbk init > "$t/op-init.out" 2>&1 || fail "operator init"
[ "$(stat -c %a "$op/key.txt")" = 600 ] || fail "the operator's private key is not mode 600"
if grep -q 'AGE-SECRET-KEY' "$t/op-init.out"; then fail "operator init printed private key material"; fi
grep -q "$(cat "$op/public.txt")" "$t/op-init.out" || fail "operator init did not show the public line"
opbk init >/dev/null 2>&1 && fail "operator init replaced an existing key"
env -i "${base_env[@]}" OPENPASSWORD_BACKUP_RECIPIENT="$op/public.txt" bash "$t/deploy/bk/backup.sh" --encrypt --direct > "$t/op.age" || fail "backup for the operator's key"
opbk check "$t/op.age" > "$t/op-check.out" 2>&1 || fail "operator check: $(cat "$t/op-check.out")"
grep -q 'RESTORE CHECK PASSED' "$t/op-check.out" || fail "operator check did not report success"
grep -Eq '^  t +1$' "$t/op-check.out" || fail "operator check did not list the vault's table and its row count: $(cat "$t/op-check.out")"
grep -q 'deleted' "$t/op-check.out" || fail "operator check did not say the opened copy was deleted"
if grep -q 'sealed-value\|test-master-key\|AGE-SECRET-KEY' "$t/op-check.out"; then fail "operator check printed a value or key material"; fi
grep -q 'ExperimentalWarning' "$t/op-check.out" && fail "operator check printed a Node warning"
[ -z "$(ls -A "$op" | grep restore-check || true)" ] || fail "operator check left the opened copy behind"
# Nothing this run did not create is ever deleted: a pre-existing look-alike folder survives a successful check, and a failed
# mktemp makes the check stop before anything is opened.
mkdir -p "$op/restore-check.decoy"; printf 'keep me' > "$op/restore-check.decoy/file"
opbk check "$t/op.age" >/dev/null 2>&1 || fail "operator check with a look-alike folder present"
[ "$(cat "$op/restore-check.decoy/file" 2>/dev/null)" = "keep me" ] || fail "operator check deleted a folder it did not create"
mkdir "$t/failing-mktemp"; printf '#!/bin/sh\nexit 1\n' > "$t/failing-mktemp/mktemp"; chmod 755 "$t/failing-mktemp/mktemp"
env -i PATH="$t/failing-mktemp:$PATH" HOME="$t" OPENPASSWORD_OPERATOR_KEYDIR="$op" bash deploy/backup/operator-backup.sh check "$t/op.age" > "$t/op-nomk.out" 2>&1 && fail "operator check ran although it could not create its private folder"
[ "$(cat "$op/restore-check.decoy/file" 2>/dev/null)" = "keep me" ] || fail "a failed folder creation deleted existing data"
grep -q 'RESTORE CHECK PASSED' "$t/op-nomk.out" && fail "operator check reported success without opening anything"
rm -rf "$op/restore-check.decoy"
printf 'garbage' > "$t/bad.age"
opbk check "$t/bad.age" > "$t/op-bad.out" 2>&1 && fail "operator check accepted a damaged file"
[ -z "$(ls -A "$op" | grep restore-check || true)" ] || fail "a failed operator check left the opened copy behind"

# 7. The root path (snapshot and encryption inside one systemd unit) is part of this test. It needs root and systemd, and a
# staging host's disposable vault (OPENPASSWORD_HOME); set OPENPASSWORD_SKIP_SYSTEMD_PATH=1 only to say, loudly, that it was NOT run.
if [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ]; then
  env -i PATH="$PATH" HOME=/root OPENPASSWORD_HOME="${OPENPASSWORD_SYSTEMD_HOME:-/var/lib/openpassword}" \
    OPENPASSWORD_NODE="${OPENPASSWORD_SYSTEMD_NODE:-/opt/openpassword/current/node/bin/node}" bash scripts/backup-age-systemd-test.sh || fail "the root systemd path"
elif [ "${OPENPASSWORD_SKIP_SYSTEMD_PATH:-}" = 1 ]; then
  echo "backup-age-test: NOTE: the root systemd path was NOT tested (OPENPASSWORD_SKIP_SYSTEMD_PATH=1)" >&2
else
  fail "the root systemd path was not tested: run as root on a staging host with systemd, or set OPENPASSWORD_SKIP_SYSTEMD_PATH=1 to record that it was not run"
fi
echo "backup-age-test: ok"
