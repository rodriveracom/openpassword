#!/usr/bin/env bash
# OpenPassword backups: the operator's one script. Run it on YOUR OWN computer. Managed jobs fetch encrypted snapshots over SSH.
#
# RUN it as a file, never paste it into the terminal (it uses set -e and exit, which would close a pasted session):
#   bash operator-backup.sh init               once: create your key pair and show the one public line to hand over
#   bash operator-backup.sh check FILE.age     prove a restore from a backup file the server team gives you
#
# During a check the decrypted vault sits briefly in a private folder under ~/.openpassword-backup/restore-check.* and is
# deleted when the script ends, even when it fails.

# What you need installed: age (macOS: brew install age; Ubuntu: apt install age), Node 24 or newer, tar.
# This script lives next to restore-encrypted.sh (deploy/backup/ in the OpenPassword release).
# Your private key stays in ~/.openpassword-backup/key.txt and is never printed, mailed or sent anywhere by this script.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
dir=${OPENPASSWORD_OPERATOR_KEYDIR:-$HOME/.openpassword-backup}
key=$dir/key.txt
say() { printf '%s\n' "$*"; }
die() { printf 'operator-backup: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"; }

init() {
  need age "On macOS run: brew install age"
  need age-keygen "It comes with age."
  [ ! -e "$key" ] || die "a key already exists at $key. Do not replace it: backups made for it could no longer be opened."
  mkdir -p "$dir"; chmod 700 "$dir"
  age-keygen -o "$key" >/dev/null 2>&1 || die "could not create the key"
  chmod 600 "$key"
  age-keygen -y "$key" > "$dir/public.txt"
  say ""
  say "Your backup key was created."
  say ""
  say "1. Give the server team ONLY this line (it is safe to send, it can lock a backup but not open one):"
  say ""
  say "   $(cat "$dir/public.txt")"
  say ""
  say "2. Keep the private key safe: $key"
  say "   Without it no backup can ever be opened. Make ONE copy that is not on this computer (a printout or a USB stick"
  say "   kept somewhere safe). Do not store the only copy inside OpenPassword. Never email it, paste it in chat or give it to anyone."
  say ""
  say "3. When the server team gives you a backup file (it ends in .age), run:"
  say "   bash $0 check THAT-FILE.age"
}

# The folder holding the opened copy. A script-global, so the exit handler can find it (a function-local variable would be
# gone by the time the handler runs). It is set only from mktemp's own output after mktemp succeeded, and CREATED marks that
# THIS run made it: the handler never deletes a path this run did not create.
WORK=
CREATED=0
cleanup() {
  trap - EXIT INT TERM HUP
  if [ "$CREATED" = 1 ] && [ -n "$WORK" ]; then rm -rf -- "${WORK:?}"; fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

check() {
  local file=${1:-}
  [ -n "$file" ] || die "usage: bash $0 check FILE.age"
  [ -f "$file" ] || die "$file is not a file"
  [ -f "$key" ] || die "no key at $key. Run: bash $0 init (but only if you have never done so)"
  need age "On macOS run: brew install age"
  need node "Install Node 24 or newer (https://nodejs.org)."
  need tar ""
  local major; major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 24 ] || die "Node 24 or newer is needed (found $(node --version))"
  [ -f "$here/restore-encrypted.sh" ] || die "restore-encrypted.sh must sit next to this script"
  mkdir -m 0700 -p "$dir"
  local made; made=$(mktemp -d "$dir/restore-check.XXXXXXXX") || die "could not create a private folder for the opened copy; nothing was opened"
  [ -d "$made" ] || die "could not create a private folder for the opened copy; nothing was opened"
  WORK=$made; CREATED=1
  mkdir -m 0700 "$WORK/restored"
  say "Opening the backup with your key (nothing leaves this computer)."
  say "While it runs, the opened copy sits in a private folder under $dir/restore-check.* and is deleted when this ends, even on failure."
  OPENPASSWORD_BACKUP_IDENTITY="$key" bash "$here/restore-encrypted.sh" "$file" "$WORK/restored" \
    || die "the restore check FAILED. Do not rely on this backup. Tell the server team exactly this message."
  say ""
  say "What the restored vault holds (names and counts only, no values):"
  RESTORED="$WORK/restored" node --no-warnings --input-type=module - <<'JS' || die "could not read the restored vault"
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.RESTORED + '/vault.sqlite', { readOnly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
for (const t of tables) {
  const name = String(t.name)
  const n = db.prepare('SELECT COUNT(*) AS n FROM "' + name.replaceAll('"', '""') + '"').get()
  console.log('  ' + name.padEnd(32) + String(n.n))
}
db.close()
JS
  local print; print=$(shasum -a 256 "$file" 2>/dev/null | cut -d' ' -f1 || true)
  [ -n "$print" ] || print=$(sha256sum "$file" | cut -d' ' -f1)
  say ""
  say "Backup file fingerprint (SHA-256): $print"
  # Delete the opened copy now, and say so only after it is verified gone.
  rm -rf -- "${WORK:?}"
  [ ! -e "$WORK" ] || die "could not delete the opened copy at $WORK. Delete that folder by hand now."
  WORK=; CREATED=0
  say "RESTORE CHECK PASSED. The opened copy has been deleted from this computer."
  say "Send the server team: the line above that starts 'RESTORE CHECK PASSED', the fingerprint, and the table list."
}

case "${1:-}" in
  new|resume|status) exec node "$here/job.ts" "$@" ;;
  init) init ;;
  check) shift; check "${1:-}" ;;
  *) say "usage: bash $0 init | check FILE.age | new HOST DESTINATION | resume JOB | status JOB   (run it as a file; never paste it into the terminal)"; exit 2 ;;
esac
