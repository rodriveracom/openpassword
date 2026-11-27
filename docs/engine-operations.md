# Engines in the OpenPassword broker

The 0.5.0 candidate builds on the 0.4.1 store. The gate builds both executables and installs them beside Node in the same release tree. Their exact versions and every dependency's checksum are in `engines/go.mod` and `engines/go.sum`; the build downloads them from the Go module proxy (or reads a module cache that already holds them) and stops on any mismatch. Development and gate hosts need Node 24.19.0 and Go 1.26.2. Production uses the bundled binaries. Startup requires both engines. Health reports starting until both are reachable. Only the broker serves clients. Multiple client hosts can use one broker.

| Responsibility | Authoritative data | Recovery |
| --- | --- | --- |
| Access and approval | The vault transaction records the principal, permission, decision or expiry. A second broker or offline rotation is fenced by a SQLite exclusive lock. | Every credential use checks authority synchronously. A restart reconstructs scheduler waits from unresolved intents. A worker commits a decision and removes its intent in one transaction. |
| Activity | The vault assigns the public event ID and stores authorized display data. SQLite triggers enqueue activity, usage and charge transitions in the writer transaction. | A single ordered publisher and a single long-poll reader use an opaque sequence as the journal ID. A reader advances the visible event ID and deletes the corresponding intent in one transaction. Killing either process before that transaction causes redelivery. |
| Consumption | The existing ledger holds attributed calls and totals. A local accounting history also records successive numeric usage and charge observations, including unresolved states. | The journal receives only the literal activity class and sequence. Retrying delivery cannot debit the budget. |
| Enrollment | Pending pairing and host requests have absolute expiry. The scheduler signals a waiting run when the broker records completion or its deadline arrives. | Expiry checks also apply at redemption. An optional UUID Idempotency-Key permits recovery of a lost successful response for at most 60 seconds. It requires the same device code, current grant, access fingerprint and host authorization. |
| Rotation and revoke | Owner actions update the credential revision or grant state immediately. | Ephemeral applies invalidation to obsolete pending and approved operations and wakes listeners. Offline wrapping-key rotation independently verifies the new envelope on retry. |

**Public cursors.** A new installation records the last pre-migration activity ID as already visible. The activity page and CLI keep using their existing workspace or grant cursor. SQLite filters both the first read and the read after a wake. An engine restart never exposes offsets or its bearer token to the caller.

**Retention and disk.** Each journal epoch stops after 8,192 delivered event references, grouped into records of up to 64 references, with a separate gateway hard cap of 16 MiB. Ephemeral rebuilds from unresolved intents after 2,048 completed jobs. A private temporary directory is unique to each engine epoch. A parent-lifetime pipe shuts down its child after broker death. OS-wide failure can leave private temporary directories for normal host cleanup. Pending intent volume, open workflows, the local audit and the accounting history grow with demand. Monitor free space on both the state and temporary filesystems. There is no bounded-duration guarantee during a disk outage. This release supports one active writer per vault.

**Secrets.** The gateway token is freshly generated per epoch and passed only to its guardian and gateway. The gateway reports its bound loopback port before it receives any authenticated request. A journal record contains an ordered list of sequence numbers independent of the credential and fixed event classes. The broker verifies the entire list against the pending queue, commits all acknowledgements together and then wakes matching audiences. Workflow requests contain an independently generated ID, fixed names, engine leases, and null values. Provider errors, names, prompts, tokens, credentials, key paths and accounting amounts stay out of those stores. SQLite vault metadata still needs private filesystem permissions and encrypted backups.

**Backup and rollback.** Ephemeral leases the snapshot step inside the existing backup command. The broker database, master key envelope and operator token are the entire encrypted backup contract. The isolated SQLite copy is checkpointed and integrity checked before encryption. The original stdout backup interface needs a fresh invocation after an interrupted stream. Managed operator jobs resume from the last durable ciphertext checkpoint. Keep the external wrapping key for every backup generation that uses it. On restore the broker reconstructs its engines from the same SQLite image as the grants and counters. Upgrades still stop, snapshot, switch and prove the service. If activation fails before the new release goes public, the updater restores the matching stopped vault snapshot and the older release. Once a release with workflow support has started publicly, the updater refuses to activate one without it, `--rollback` included; going back then means restoring the pre-upgrade copy or backup by hand and losing everything written since. Never copy a live journal or workflow database between releases. Restoring an older vault also restores its older authorization state; reconcile later revocations before opening it to traffic.

**Wrapping-key rotation.** The service owner runs the following on the broker host, without sudo, after the deployment administrator has stopped the broker and scheduled backups. Both key files must already exist outside the vault, owned by the service identity with private permissions. Supply absolute paths. The exclusive lock rejects an active engine-backed broker. After success, configure the service to use the replacement key file, restart it and verify access. Keep the old key offline for recovery of older backups.

```sh
/opt/openpassword/current/node/bin/node /opt/openpassword/current/deploy/rotate-wrapping-key.ts /var/lib/openpassword /secure/previous.key /secure/replacement.key
```

**Verification.** A developer or reviewer runs these commands at the checkout root on the gate host without sudo. The cost probe requires Linux. The release build also needs its independently signed CLI. The encrypted backup test requires age, age-keygen and Linux tmpfs. The staging root/systemd branch has a separate acceptance run.

```sh
npm ci && make acceptance
node scripts/check-dependency-age.ts
OPENPASSWORD_SKIP_SYSTEMD_PATH=1 make backup-age-test
```

`make acceptance` runs `make verify`, the streaming load with a worker restart (`scripts/agent-load.ts`), the backup interruption and restore check (`scripts/backup-job-test.sh`) and, on Linux only, the idle CPU and memory probe (`scripts/engine-cost.ts`). The backup check needs `age` and `age-keygen` on the PATH; `go install filippo.io/age/cmd/...@v1.2.1` provides them. The repository runs no hosted workflow. Keep a passing run at the exact commit for Linux ARM64 and for macOS before relying on that platform.

The build compiles the two MIT-licensed engines from the module versions pinned in `engines/go.mod`, after `go mod verify` checks every module against `engines/go.sum`. Dostoevsky is pinned to 93870fe2322df80636f824d0a39fe7872e0b8bf8. Ephemeral is pinned to v0.3.0 (c2e078a2b30481e3df2300c24891befebf688c4c). The TypeScript application uses the upstream JavaScript HTTP client and a serialized JSON-lines adapter for the Ephemeral CLI. A failed request closes that CLI. The next epoch reconstructs outstanding work from committed intents.

## Recoverable operator backups

The operator runs these commands on their own workstation from the full matching release or a checkout with built engines, without sudo. The workstation needs Node 24, age, its existing operator identity and disk space for staging and checking the archive. The destination must be an operator-owned private directory. The command creates it if needed.

```sh
job=$(bash deploy/backup/operator-backup.sh new backup@example.com "$HOME/verified-backups")
bash deploy/backup/operator-backup.sh resume "$job"
bash deploy/backup/operator-backup.sh status "$job"
```

The SSH account needs existing key-based access to run the installed encrypted-backup command using noninteractive sudo on the broker. SSH host verification stays enabled. The operator's private age identity stays on the workstation. For a user installation on the same machine, substitute `local` for the SSH host. This uses the existing direct backup mode and its memory-backed staging checks. Systemd staging still requires its own operator test.

| Last durable step | What exists | What resume does |
| --- | --- | --- |
| created | Private settings, local UUID and receipt | Fetch a fresh snapshot. An interrupted snapshot or encryption stream is discarded. |
| encrypted | A completed, fsynced ciphertext file and SHA-256 on the workstation | Copy the same ciphertext into the destination, verify the bytes and publish the file without overwriting a different backup. |
| delivered | A destination file matching the ciphertext digest | Perform the existing restore and SQLite integrity check on the operator machine. A missing or wrong identity leaves the job at delivered. |
| verified | The restore passed and its digest is recorded | Recheck the destination bytes and remove redundant staging ciphertext. Status reports whether the destination still matches. If the verified file is subsequently lost, create a new backup. |

The default job directory is `~/.openpassword-backup/jobs`. Its private settings bind the source and destination. Ephemeral persists the job ID, three named activities, engine leases and null values. A SQLite exclusive lock prevents concurrent resume, and the active operator process renews the lease during slow transfers. The strongest completion claim is `restore_verified: true` from a fresh status check. This establishes archive integrity and successful restoration of the SQLite store. Access to any external wrapping keys required to use the restored vault remains a separate recovery requirement.

The broker's snapshot and encryption share one streaming step. A lost connection before its durable ciphertext checkpoint requires a fresh snapshot. Subsequent steps reuse that exact ciphertext. The restore check briefly materializes private files on the operator machine under the existing operator-backup policy. Configure the operator key directory and the job directory on protected local storage. The destination supports local filesystems and mounted filesystems providing durable fsync and atomic hard links.

## Measuring the gateway

A reviewer runs `node --import tsx scripts/agent-load.ts` from the checkout on a gate host without sudo. The test sends five streamed requests from each of 60 distinct grants over loopback, with two concurrent activity readers. The simulated upstream emits a content frame followed by a usage frame. The test kills the Ephemeral worker, checks replacement readiness, verifies every settled charge and both replay counts, then reports latency and queue depth. Spend visibility is measured from request start to a 10 ms local ledger sample. Audit lag is measured from the timestamp in the event to its arrival at a watcher. The driver and broker share a process. The numbers include driver work and exclude a real model provider's latency.

The broker wakes idle workers on local queue writes. A bounded one-second scan also discovers writes from other connections and recovers lost hints. Per-process idle measurements on Linux use `node --import tsx scripts/engine-cost.ts`. The POSIX shell supervisors retain the broker-lifetime pipes and clean up private epoch directories. Their extra stream pipe reader is included in the reported process count.

**A stuck workflow engine.** When a workflow call gets no answer within ten seconds, the broker kills the engine's process group. If the broker itself is killed outright while the engine is stuck, the broker can no longer do that. A systemd stop or restart removes the engine with the service's control group; for a user installation or `make dev`, run `ps -Ao pid,ppid,pgid,command | grep openpassword-flow-` as the account that ran the broker (no sudo). Each engine start has a shell running `engine-guardian.sh` and an `ephemeral` child; the command line shows which installation's `engine-bin` it came from. A leftover is one whose shell no longer has a running broker as its parent. Stop it with `kill -KILL -- -PGID`, using the PGID shown for that shell.

Set `OPENPASSWORD_BENCH_CALLS_PER_AGENT=25` for a longer 1,500-request run. A production sizing exercise should use the actual disk, provider response times and sustained traffic profile. An isolated burst can drain quickly even when some events were several seconds behind during the burst.
