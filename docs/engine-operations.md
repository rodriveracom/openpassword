# Engines in the OpenPassword broker

The 0.5.0 candidate builds on the 0.4.1 store. The gate builds both executables and installs them beside Node in the same release tree. Development and gate hosts need Node 24.19.0 and Go 1.26.2. Production uses the bundled binaries. Startup requires both engines. Health reports starting until both are reachable. Only the broker serves clients. Multiple client hosts can use one broker.

| Responsibility | Authoritative data | Recovery |
| --- | --- | --- |
| Access and approval | The vault transaction records the principal, permission, decision or expiry. A second broker or offline rotation is fenced by a SQLite exclusive lock. | Every credential use checks authority synchronously. A restart reconstructs scheduler waits from unresolved intents. A worker commits a decision and removes its intent in one transaction. |
| Activity | The vault assigns the public event ID and stores authorized display data. SQLite triggers enqueue activity, usage and charge transitions in the writer transaction. | A single ordered publisher and a single long-poll reader use an opaque sequence as the journal ID. A reader advances the visible event ID and deletes the corresponding intent in one transaction. Killing either process before that transaction causes redelivery. |
| Consumption | The existing ledger holds attributed calls and totals. A local accounting history also records successive numeric usage and charge observations, including unresolved states. | The journal receives only the literal activity class and sequence. Retrying delivery cannot debit the budget. |
| Enrollment | Pending pairing and host requests have absolute expiry. The scheduler signals a waiting run when the broker records completion or its deadline arrives. | Expiry checks also apply at redemption. An optional UUID Idempotency-Key permits recovery of a lost successful response for at most 60 seconds. It requires the same device code, current grant, access fingerprint and host authorization. |
| Rotation and revoke | Owner actions update the credential revision or grant state immediately. | Ephemeral applies invalidation to obsolete pending and approved operations and wakes listeners. Offline wrapping-key rotation independently verifies the new envelope on retry. |

**Public cursors.** A new installation records the last pre-migration activity ID as already visible. The activity page and CLI keep using their existing workspace or grant cursor. SQLite filters both the first read and the read after a wake. An engine restart never exposes offsets or its bearer token to the caller.

**Retention and disk.** Each journal epoch stops after 8,192 delivered records, with a separate gateway hard cap of 16 MiB. Ephemeral rebuilds from unresolved intents after 2,048 completed jobs. A private temporary directory is unique to each engine epoch. A parent-lifetime pipe shuts down its child after broker death. OS-wide failure can leave private temporary directories for normal host cleanup. Pending intent volume, open workflows, the local audit and the accounting history grow with demand. Monitor free space on both the state and temporary filesystems. There is no bounded-duration guarantee during a disk outage. This release supports one active writer per vault.

**Secrets.** The gateway token is freshly generated per epoch and passed only to its guardian and gateway. The gateway reports its bound loopback port before it receives any authenticated request. A journal record contains a sequence independent of the credential and a fixed class. Workflow requests contain an independently generated ID, fixed names, engine leases, and null values. Provider errors, names, prompts, tokens, credentials, key paths and accounting amounts stay out of those stores. SQLite vault metadata still needs private filesystem permissions and encrypted backups.

**Backup and rollback.** Ephemeral leases the snapshot step inside the existing backup command. The broker database, master key envelope and operator token are the entire encrypted backup contract. The isolated SQLite copy is checkpointed and integrity checked before encryption. A failed streaming backup needs a fresh invocation and output file. Keep the external wrapping key for every backup generation that uses it. On restore the broker reconstructs its engines from the same SQLite image as the grants and counters. Upgrades still stop, snapshot, switch and prove the service. Rollback restores the matching stopped vault snapshot. Never copy a live journal or workflow database between releases. Restoring an older vault also restores its older authorization state; reconcile later revocations before opening it to traffic.

**Wrapping-key rotation.** The service owner runs the following on the broker host, without sudo, after the deployment administrator has stopped the broker and scheduled backups. Both key files must already exist outside the vault, owned by the service identity with private permissions. Supply absolute paths. The exclusive lock rejects an active engine-backed broker. After success, configure the service to use the replacement key file, restart it and verify access. Keep the old key offline for recovery of older backups.

```sh
/opt/openpassword/current/node/bin/node /opt/openpassword/current/deploy/rotate-wrapping-key.ts /var/lib/openpassword /secure/previous.key /secure/replacement.key
```

**Verification.** A developer or reviewer runs these commands at the checkout root on the gate host without sudo. The cost probe requires Linux. The release build also needs its independently signed CLI. The encrypted backup test requires age, age-keygen and Linux tmpfs. The staging root/systemd branch has a separate acceptance run.

```sh
npm ci && make verify
node scripts/check-dependency-age.ts
node --import tsx scripts/engine-cost.ts
OPENPASSWORD_SKIP_SYSTEMD_PATH=1 make backup-age-test
```

The gate verifies the source archive hashes before compiling from the two vendored MIT projects. Dostoevsky is pinned to 93870fe2322df80636f824d0a39fe7872e0b8bf8. Ephemeral is pinned to c2e078a2b30481e3df2300c24891befebf688c4c. The archives include licenses and Ephemeral's vendored dependencies. The TypeScript application uses the upstream JavaScript HTTP client and a serialized JSON-lines adapter for the Ephemeral CLI. A failed request closes that CLI. The next epoch reconstructs outstanding work from committed intents.
