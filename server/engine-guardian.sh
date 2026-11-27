#!/bin/sh
# Private broker child. Workflow stdin carries requests; stream stdin signals parent death.
set -eu
mode=$1
dir=$2
shift 2
exec 3<&0
monitor=
if [ "$mode" = workflow ]; then
  "$@" <&3 3<&- &
else
  "$@" </dev/null 3<&- &
fi
engine=$!
cleanup() {
  trap - EXIT TERM INT
  if [ -n "$monitor" ]; then kill "$monitor" 2>/dev/null || true; fi
  kill "$engine" 2>/dev/null || true
  wait "$engine" 2>/dev/null || true
  rm -rf -- "$dir"
}
trap cleanup EXIT
trap 'exit 1' TERM INT
if [ "$mode" = stream ]; then
  (read -r unused || true; kill "$engine" 2>/dev/null || true) <&3 >/dev/null &
  monitor=$!
fi
exec 3<&-
wait "$engine"
