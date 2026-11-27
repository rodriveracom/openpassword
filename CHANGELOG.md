# Changelog

## 0.5.0 candidate — durable activity and workflows

### Stream delivery and recoverable operator backups

- Batches up to 64 ordered event references in one journal record. Broker writes wake the publisher and workflow scheduler. Lightweight shell supervisors release engine processes on broker exit.
- Adds operator-side backup jobs with durable progress, resumable encrypted delivery, checksums, and a restore check using the operator’s key. See [engine operations](docs/engine-operations.md).
- Adds a 60-agent streaming workload, per-process idle measurements, and backup interruption cases to native acceptance.

### Initial engine integration

- The console and CLI now read activity carried by a private Dostoevsky gateway. Existing activity cursors survive restarts. Usage and metering transitions have a transactional delivery queue.
- Ephemeral drives enrollment expiry, approval decisions, revocation and credential-rotation propagation, the backup snapshot step, and offline rotation of the vault wrapping key.
- The local client can retry a lost device-token response. An expired pairing now reports the reason to the operator.
- Gate builds include both pinned engine binaries. See [engine operations](docs/engine-operations.md) for retention, rollback, recovery and verification.

## Unreleased security review

### Human vault security and remote model custody (unreleased)

- Added passkey sign-in and single-use approval bound to sensitive console requests for enrolled profiles. Changing an existing sign-in password also requires the current password.
- Owners can share a readable item revision with a named recipient or a group using independently verified recipient cards. Group publication is atomic and roster changes withdraw prior group shares. Editing, deletion, expiry or owner revocation ends further delivery.
- Added offline recovery kits, optional named recovery custodians, and browser unlock with a compatible user-verifying, device-bound PRF authenticator. Device enrollment expires after thirty days and can be revoked online.
- Model connections can use a separately administered OpenPassword gateway. A scoped downstream access token replaces the provider key on the routing host. Both services enforce their own model lease. Generic operation invocation now rejects leased chat calls that must go through metering.
- Added an opt-in external wrapping-key requirement and installer downgrade checks for active passkey or model custody records. See the security operations guide for limitations and review status.

- Owners can upgrade existing single-key private vaults in the browser. The upgrade re-encrypts every item, preserves gateway connections and switches the vault atomically. Stale clients must unlock again and pending CLI deposit receipts expire.

- New personal vaults use a separate vault passphrase and client-generated 256-bit key. New and edited items have random per-item encryption keys. Existing vaults and items remain readable.
- Added owner-authorized, single-use CLI deposits. The owner seals the item in the browser; the CLI submits only a five-minute receipt.
- The release gate validates dependency publication age and the signed standalone client. Workstation updates require independently provisioned trust. Root recovery checks its installed runtime and suppresses child stderr.
- Added cross-site mutation rejection and reauthorization of buffered model responses and streaming chunks. See SECURITY.md for trust boundaries, remaining gaps and staging tests.

### HTTP API

- Published the core agent API contract at `GET /v1/openapi.json`. Added a direct HTTP walkthrough, a dependency-free Node fetch example for host-bound grants, and a TCP integration test covering approval, invocation, replay, rotation and revocation.

### Native harness integrations

- Generate a local, per-agent executable with `harness prepare`. It pins the broker, OS identity, agent profile and host signing socket and supports a remote deployment.
- Added native coding-assistant skills, Python framework tools, Rasa custom actions and a TypeScript subprocess client. The [setup guide](examples/harnesses/README.md) covers all 16 adapter targets. MCP registration remains optional.
- Added stdin JSON operations with idempotency keys and connection identity checks, plus regression coverage for authorization, revocation and profile pinning.

## 0.4.1 · 2026-11-25

- Add `deploy/backup/operator-backup.sh`, one file the operator runs on his own computer: `init` creates his key pair and shows only the public line to hand over, `check FILE.age` proves a restore (table names and counts only, the opened copy deleted on exit).
- Add an encrypted backup that needs no secret on the host: `backup.sh --encrypt` writes the snapshot to stdout as age ciphertext for the operator's public key, so the host can encrypt but never decrypt, and `restore-encrypted.sh` opens it on the operator's machine with his private key and checks the vault. As root the snapshot and the encryption run inside one transient unit with a tmpfs runtime directory that systemd removes (cancelling stops and joins the unit); otherwise the plain snapshot is staged only on tmpfs or ramfs, and the backup refuses when swap could write it to an unencrypted disk. The recipient file is validated once (regular file, owner, no group or world write, only `age1` keys) and the validated keys are passed to age. `restore-encrypted.sh` examines the archive before extracting: only regular `vault.sqlite`, `master.key` and `operator.token`, each once. Tests: `make backup-age-test`, `make backup-age-systemd-test`. The host-held borg backup remains optional and is not enabled by the updater.
- **Deployment note:** set `OPENPASSWORD_TRUST_PROXY=127.0.0.1` in the broker drop-in when the reverse proxy runs on the same host; without it every client shares one 60-a-minute bucket for sign-in and pairing.
- Sign-in and pairing limits are per source address when `OPENPASSWORD_TRUST_PROXY` names the reverse proxy (off by default; forwarded addresses from other peers are ignored; wildcards and over-broad ranges are refused). Behind a proxy without it, all clients share one bucket.
- Add a per-grant ceiling on authenticated `/v1` requests, 600 a minute by default (`OPENPASSWORD_GRANT_RATE`; an empty or malformed value refuses to start, and only an explicit `0` disables it, with a warning). Expired counters are swept so many sources cannot grow memory without bound.
- Add `openpassword artifact ID [SHA256]`, which writes an artifact's exact bytes to stdout (for example a Gmail page read) through the CLI, so a caller that holds no token can fetch it. With a digest (the `content_sha256` from the invoke result, with or without the `sha256:` prefix) it verifies the bytes first and writes nothing on a mismatch.

## 0.4.0 · 2026-11-25

The wording of this entry on host switching and rollback was corrected after the archive was built; the corrected text ships in the 0.4.1 source. The 0.4.0 archive was never published as a separate release and carries the earlier wording.

### Scope since 0.2.0

The comparison starts at the published 0.2.0 source commit `6a7a4b6`, integrated into main by `21ffd6f`. It includes the maintainer and council branches in the candidate history. Items that already shipped from main in 0.3.0 and 0.3.1 (bundled Node, verified archives, backups, the `openpassword-` header rename, the loopback console bind) are listed under those versions and not repeated here. The 0.2.0 baseline already provided account linking, organization and personal credential ownership, independent sharing expiry, consumption recording, and remote CLI/MCP integration for coding agents.

### Personal vault, approved hosts and agent grants

- Personal vault items have browser-encrypted names and secret values. Each profile unlocks its own vault with a separately saved recovery key. Hiding the page, navigating away or five minutes of inactivity locks it. Explicit delegation creates a personal provider connection with a gateway-readable copy. Editing the private item leaves copy rotation to its owner.
- First administration, host enrollment and agent approval are separate. A CLI host registers an Ed25519 public key using a one-use web ticket. Its Unix socket service signs CLI and MCP requests. A human approves each agent request for a specific connection, operations and expiry. A different host cannot use the agent's token. Revoking a host blocks subsequent calls from its agents.
- New workspaces on the deployed service require host-bound grants. Workspaces with existing grant history keep standalone access until their first successful host enrollment; when such a workspace switches, re-pair its existing standalone agents then, and make signing-compatible CLI, MCP or an equivalent integration available before it does. A raw bearer-only client has no signing integration and stops working at that point. The updater refuses a move to a release that predates signature enforcement while active host-bound grants or unredeemed host-bound enrollment tokens exist; revoke them first.

### Model and voice policy

- Added standalone model and voice policy evaluation, descriptor validation, family and alias resolution, wildcard limits, and explicit voice endpoint classification. The vendor registry contains 12 candidate descriptors. The live broker's scoped model discovery and metered chat remain distinct from this policy engine. The candidate descriptors have not been qualified for live routing.

### Deployment and key custody

- Support an independently provisioned wrapping key for new or existing vaults. Wrapped snapshots require the separate credential to decrypt item values.

- Add SSH-backed CLI setup codes for first administration. Codes expire after ten minutes and issuing another supersedes the previous one. The web console can then authorize the agent host. Reject nonprivate or malformed host key files and invalidate pre-setup administrator sessions when the first owner is created.

- Replace the Python updater and production build procedure with verified archive installation. The production host uses a small shell bootstrap, the archive’s own Node v24.19.0 and a TypeScript activation controller. A failure before the commit restores the old release, its systemd units (including the host-Node to bundled-Node transition) and the verified vault copy where one was taken; a public startup or readiness failure after the commit is recovered forward with `--recover`. Retain the previous host runtime for rollback.

### Vault interface

- Link provider connections to saved vault items and trace agent grants in both directions. Grant views show operations, model, expiry and revocation. Direct and OAuth credentials retain their existing custody.

- Add matching record marks to vault rows and readers, a workspace-specific engraved directory cover, a clear-search control, and a separate access and activity section alongside desktop credential fields. Group integrations by capability and show operation counts beside each provider.
- Rebuild the vault directory, masked item reader and first-run account screen with the shared family tokens and local fonts. Add persistent System, Light and Dark appearance, bounded server-side item search, stable item and activity URLs, and role-aware copy and reveal controls.
- Apply the palette to connections, integrations, grants, approvals, usage, activity and settings. Collapse mobile navigation and add a searchable workspace switcher.

### Enrollment and agent access

- The first administrator enters the installation setup code in the console. The setup screen directs them to Workspace → CLI hosts to enroll an agent machine.
- Access grants can issue a single-use CLI enrollment token valid for up to ten minutes. The broker stores its digest and exchanges it for scoped device credentials in one SQLite transaction. The console displays the grant ID and CLI connection time. This standalone flow remains available to upgraded standalone workspaces until they switch to host-required access.
- Download the standalone Node.js 24+ CLI from the installation. Use `connect` to enroll with hidden input and `whoami` to verify the active grant. The CLI and MCP expose capabilities, connection and model discovery, metered chat, and scoped activity. Chat accepts an idempotency key. Normal CLI token reads use a read transaction, with serialized writes for refresh.

### Navigation and activity

- Added bookmarkable routes for connections, integrations, grants, approvals, consumption, activity, vault items and workspace settings.
- The browser and CLI can follow activity over HTTP long polling. SQLite stores the ordered events. A process-local notification wakes waiting readers for the relevant workspace or grant. Readers can resume after an event ID. The broker bounds pending waits and checks access again after a wake.

### Service and client updates

- Added staged activation and explicit rollback for the supplied Linux systemd services. The updater preflights the candidate against a disposable vault, serializes switches, records interrupted activation and restores the previous release before the commit; failures after the commit are recovered forward.
- A supporting broker drains accepted requests before restart. New requests receive HTTP 503 and a retry hint. Activity watchers reconnect across temporary gateway failures.
- Added a Mac/Linux CLI updater that supports an independently supplied release digest, checks the downloaded bundle against the broker’s SHA-256, runs an offline startup check and replaces the executable atomically. Existing profiles are reused. Running MCP processes pick up the update on restart.

- Activation copies the stopped state directory (manifest, integrity check, owners and modes kept) before the candidate starts and journals it. The candidate is proven on a private broker port against the real store before any public traffic; until then a failure or interruption restores the verified copy (staged, then swapped in) with the old release, and afterwards the journal is committed and a failure is fixed forward. The copy is deleted only after the journal stops naming it.
- The activation controller's readiness probe dials the console at 127.0.0.1, the address its unit binds (0.3.1).

### Verification tools

- Added enrollment, profile isolation, cursor and drain regressions, a reproducible model-gateway load test, and a two-version upgrade rehearsal. The operations guide covers the benchmark, server activation, client update and rollback.

## 0.3.1 · 2026-11-24

- The console binds 127.0.0.1 explicitly (systemd unit, `npm start`, `npm run dev`). With `-H localhost` Node 24 can listen on `::1` only, so a proxy or probe dialing 127.0.0.1 got connection refused. A test keeps the unit, the console rewrites and the broker on the same address.

## 0.3.0 · 2026-11-24

- The release archive bundles the pinned Node.js v24.19.0 (`node/bin/node`, from the official tarball checked against `scripts/node-pins.txt`); the systemd units run it by absolute path, so a host needs no system Node. `RELEASE.json` records the bundled binary and tarball sha256. The build now needs `xz` and network access to nodejs.org. The root package, lockfile root and MCP server version are 0.3.0; the workspace packages under `packages/` keep their own 0.2.0 versions.

- Adds an encrypted off-host backup and a tested restore (`deploy/backup/`, borg with client-side encryption; daily timer unit). `master.key` and the vault travel together only inside the encrypted archive.

Breaking wire changes. Clients and integrations written against the predecessor service's names must update.

- Protocol, capability and on-behalf-of headers use only the `openpassword-` prefix. The legacy headers are no longer sent or accepted.
- Relay headers are `openpassword-upload-link`, `openpassword-relay-seal`, `openpassword-connection`, `openpassword-content-type` and `openpassword-content-range`. The earlier relay headers, which used a different prefix, are no longer accepted.
- Batch manifest and approval-view schema identifiers, and the human-delegation token type, use the `openpassword-` prefix.
- The delegation key document is served at `/.well-known/openpassword-delegation-keys.json`.
- Notebook conversion receipts use the schema `openpassword.notebook-semantics.v1`. Nothing reads the earlier identifier, so earlier receipts are not re-verified.
- Adds `make package COMMIT=<sha>` and `make checksum`. The release is built from that exact commit, requires Node 24.19.0, ships only runtime files and production dependencies, and produces an archive that is reproducible except for the listed per-build secret files (`scripts/per-build-files.txt`), with `RELEASE.json`, a manifest, a completion marker and a `.sha256` sidecar. Build diagnostics are not shipped. The corresponding-source archive now includes the packaging scripts and has normalized metadata.
- The systemd units run from `/opt/openpassword/current`, a symlink to a versioned release directory.
- The reference runner takes the predecessor's identifier prefix from `REFERENCE_ID_PREFIX`.

## 0.2.0 · 2026-11-22

Adds scoped action delegation and refresh-family revocation, retired-key status checks, monetary model leases, tool-call chat, GitHub admission, per-provider dispatch stops, Loops pacing and batch approval views, digest-verified YouTube relay transfer, Notion OAuth, Google batch builders, newsletter and template approval previews, and guarded HubSpot template publication. Adds encrypted Loops and Twilio webhook inboxes, Revolut projections, signed-off publishing journals, TikTok operations, X thread planning and notebook semantic receipts. Adds separate Linux web and broker service identities and a differential fixture runner. Adds scoped operation pauses, legacy Bluesky and Threads publishing, HubSpot issue-bundle uploads, Loops message and audience updates, upload lifecycle and scoped Supabase row mutations. See PARITY.md for remaining replacement gaps.


## 0.1.0 · 2026-11-22

First TypeScript implementation of OpenPassword. The service includes the Next.js operator console, Fastify broker, SQLite custody, human vault items, workspace roles, scoped device pairing, approval queue and actor-attributed audit history. Adds provider-bound operations, selected-resource reads, Gmail artifacts, bounded Loops imports, unsent draft allowances, YouTube resumable uploads and model streaming. Ships the client, CLI, connector library and schemas under MIT.

See PARITY.md for the replacement status and the outstanding differences from the reference.
