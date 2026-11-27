#!/usr/bin/env bash
# Gate maintainer on Linux or macOS, checkout root, no sudo. Requires age and Node 24.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export OPENPASSWORD_BACKUP_JOBS="$root/jobs" OPENPASSWORD_OPERATOR_KEYDIR="$root/key" WORK="$root"
mkdir "$root/key" "$root/receive" "$root/vault" "$root/bin"
age-keygen -o "$root/key/key.txt" >/dev/null 2>&1
node --input-type=module - "$root/vault" <<'JS'
import {DatabaseSync} from 'node:sqlite'
import {writeFileSync} from 'node:fs'
const p=process.argv[2],db=new DatabaseSync(p+'/vault.sqlite')
db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('synthetic')");db.close()
writeFileSync(p+'/master.key','synthetic');writeFileSync(p+'/operator.token','synthetic')
JS
( cd "$root/vault"; tar -cf - vault.sqlite master.key operator.token ) | age -r "$(age-keygen -y "$root/key/key.txt")" > "$root/source.age"
cat > "$root/bin/ssh" <<'SH'
#!/bin/sh
set -eu
echo invoked >> "$WORK/calls"
case "$(cat "$WORK/mode")" in
 interrupt) head -c 10 "$WORK/source.age"; touch "$WORK/started"; while [ -e "$WORK/block" ]; do sleep .1; done; exit 1 ;;
 complete) sleep 6; cat "$WORK/source.age" ;;
 *) exit 1 ;;
esac
SH
chmod +x "$root/bin/ssh"
export PATH="$root/bin:$PATH"
job(){ node deploy/backup/job.ts "$@"; }
id=$(job new backup@example.com "$root/receive")
echo interrupt > "$root/mode"; touch "$root/block"
job_file="$root/jobs/$id/receipt.json"
node deploy/backup/job.ts resume "$id" >"$root/result" 2>/dev/null &
runner=$!
for i in {1..200}; do [ -f "$root/started" ] && break; sleep .05; done
test -f "$root/started"; kill -KILL "$runner"; wait "$runner" 2>/dev/null || true; rm "$root/block"
job status "$id" | grep -q '"step":"created"'
# A colliding destination must survive. Resume captures a fresh, complete remote stream.
echo occupied > "$root/receive/$id.age"
echo complete > "$root/mode"
if job resume "$id" 2>/dev/null; then exit 1; fi
grep -qx occupied "$root/receive/$id.age"
grep -q '"step":"encrypted"' "$job_file"
rm "$root/receive/$id.age"
mv "$root/key/key.txt" "$root/key/offline"
# The operator can deliver while their decryption key is offline.
if job resume "$id" 2>/dev/null; then exit 1; fi
job status "$id" | grep -q '"step":"delivered"'
mv "$root/key/offline" "$root/key/key.txt"
job resume "$id" >/dev/null
job resume "$id" >/dev/null
job status "$id" | grep -q '"restore_verified":true'
test "$(wc -l < "$root/calls")" -eq 2
cmp "$root/source.age" "$root/receive/$id.age"
test ! -e "$root/jobs/$id/archive.age"
printf changed >> "$root/receive/$id.age"
job status "$id" | grep -q '"restore_verified":false'
if job resume "$id" 2>/dev/null; then exit 1; fi
echo 'Passed interrupted SSH stream, renewed lease, destination collision, offline key, restore, replay and corruption checks.'
