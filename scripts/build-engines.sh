#!/bin/sh
# Gate maintainer or developer, on the target build host, without sudo.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
for(const line of readFileSync('vendor/dogfood/SHA256SUMS','utf8').trim().split('\n')){
  const [digest,path]=line.split(/ +/)
  if(createHash('sha256').update(readFileSync(path)).digest('hex')!==digest) throw Error('Engine source digest mismatch')
}
JS
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p engine-bin "$tmp/dostoevsky" "$tmp/ephemeral"
for name in dostoevsky ephemeral; do
  tar -xzf "vendor/dogfood/$name.tar.gz" -C "$tmp/$name"
  binary=$name
  [ "$name" != dostoevsky ] || binary=dostoevsky-gateway
  (cd "$tmp/$name" && CGO_ENABLED=0 GOPROXY=off GOTOOLCHAIN=local go build -trimpath -buildvcs=false -o "$root/engine-bin/$binary" "./cmd/$binary")
done
