# Provider and deployment reference

## Provider setup

Google OAuth uses authorization code, PKCE and a single-use session-bound state. Register the console origin followed by `/api/oauth/google/callback` in the Google client. Configure the client ID, secret and scope through the console. Gmail page reads require explicitly authorized label IDs. The Google Sheets connector restricts requests to selected spreadsheet IDs. For a read-only Revolut credential, supply account IDs. Twilio accepts `accountSID:authToken`. Supabase Database takes a JSON credential with `project` and `key`, and an explicit list of table names. The public briefing adapter does not send credentials upstream. GitHub also accepts a JSON credential with app_id, installation_id, private_key and an explicit repository_ids list for read-only installation tokens. Reddit accepts client_id, client_secret and user_agent. Bluesky accepts identifier and app_password. In those modes the broker obtains the short-lived provider token at dispatch. Other token-based integrations take the upstream access token or API key. Provider-specific scopes, account entitlement and test accounts determine which upstream calls succeed.

## Operations

The broker binds to loopback. Next.js also defaults to localhost. Use a TLS reverse proxy for remote access and publish only the intended surfaces. `OPENPASSWORD_HOME` selects the data directory. `OPENPASSWORD_PORT` changes the broker port and the console rewrite destination. Set it consistently at build and start. `OPENPASSWORD_WEB_ORIGIN` must match the browser origin. Enable the optional YouTube chunk relay with `OPENPASSWORD_YOUTUBE_RELAY=1`. Provider keys are entered via the console, without provider environment variables.

Keep the SQLite database and master.key together in a protected backup. For an offline backup stop the service, copy the complete data directory including SQLite sidecars, and preserve file permissions. The default deployment uses a local master key and process-level trust. Use a dedicated service user with a private home. Protect the operator token during initial setup. The local launch and storage layout are designed for Linux including ARM64. The service has been tested on Linux x86-64.

## Backups

The data directory holds `vault.sqlite` (encrypted provider credentials, grants, history), `master.key` (the key for those credentials) and `operator.token`. A copy of the database without `master.key` cannot be read, and a copy of both together must never be stored unencrypted off the host. `deploy/backup/backup.sh` therefore writes both into one **borg** archive, encrypted on the host before upload; only the encrypted archive leaves it.

Setup, once, as root. Create `/etc/openpassword/backup.env` (owner root, mode 0600) with `BORG_REPO` (for example an `ssh://` repository on your storage), `BORG_PASSCOMMAND` (a command that prints the passphrase, such as `cat /etc/openpassword/backup.pass` with that file at mode 0600) and optionally `BORG_RSH` for the SSH key and port. `BORG_PASSPHRASE` in the file is refused. Initialise the repository with `borg init --encryption=repokey-blake2` using the same settings. Keep the passphrase and a copy of the repository key somewhere other than the backed-up host: without them an archive cannot be opened.

Run `deploy/backup/backup.sh` as root. It takes a consistent snapshot with SQLite's online backup (safe while the broker runs), under the broker's own service identity so that it cannot change file ownership in the state directory, then runs `borg create`. `--direct` runs as the user that owns the data directory (used by the tests and for local installs). `deploy/systemd/openpassword-backup.service` and `.timer` run it daily; install them like the other units and enable the timer. The scripts use the bundled Node (`OPENPASSWORD_NODE` overrides the path).

To restore, run `deploy/backup/restore.sh <archive-name> <empty-dir>` (find names with `borg list`). It restores into an empty directory, never over a live one, and checks that the vault passes SQLite's integrity check. To bring a host back: stop both services, move the restored files into the state directory with their ownership as before, start the broker, then the console. Practise a restore before relying on the backups. `make backup-test` exercises backup and restore against a local borg repository (Linux, needs borg).

## Installer

`deploy/install.sh` performs the install procedure in Release package, below, as one command on the target Linux host, as root, and prints one JSON object (`state`: `ready`, `needs_human` or `failed`; `checks`, `needs_human` steps, the console URL and an `error` code). It never builds or downloads anything and never prints a secret.

```sh
sudo bash install.sh agent plan  --archive openpassword-0.3.0-linux-arm64.tar.gz --sha256 <digest> --commit <commit> --version 0.3.0 --arch arm64 --origin https://pass.example.com
sudo bash install.sh agent apply  (same options)
sudo bash install.sh agent status
```

`--sha256` and `--commit` come from the gate record for that release, never from the archive's own sidecar; take `install.sh` itself from the same tagged release, not from the archive you are about to verify. `plan` changes nothing. `apply` verifies the staged copy, checks `RELEASE.json` and the bundled Node under the unit sandbox, switches the `current` symlink, installs the units and an origin drop-in, restarts broker then console, and waits for both to answer. If they do not, it restores the previous release and units and reports `readiness_failed`. Rerunning the installed version changes nothing. On a fresh install it returns `needs_human` with the **path** of the setup-code file; a person reads it on the server and creates the administrator account in the console. The disposable-vault preflight and request drain are marked as skipped; they are not implemented yet. `make installer-test` runs the script against a fake host (Linux).

## Packages and verification

- `packages/client` provides the typed device client.
- `packages/cli` implements pairing, token rotation, capability use and revocation.
- `packages/schemas` defines the public request validators.
- `packages/connectors` builds fixed provider requests. It also includes FFmpeg helpers (require system ffmpeg and ffprobe), percent-script notebook conversion and webhook verification.
- `server` owns authentication, dispatch, SQLite and envelopes. `app` owns the browser console. `tests` contains deterministic contract and workflow checks.

Run `make verify`. Provider tests use synthetic data and controlled transports. See [implementation coverage](../PARITY.md) for the distinction between implementation, exercised behavior and migration readiness.

Copyright 2026 Dreamhuggers. The service is AGPL-3.0-only. Each reusable package includes its MIT license. The bundled Space Grotesk font carries its SIL Open Font License in public/fonts.

## Sign in to another application

Under **Workspace → Register app**, enter the application's exact HTTPS callback and audience. Activate its registration. A signed-in workspace member can confirm an identity-only handoff at `/delegate` with a one-use S256 challenge. The application backend exchanges the returned code at `/delegate/exchange` and verifies the Ed25519 signature against its pinned key. The public key document is available at `/.well-known/openpassword-jwks.json`. Identity-only grants expire within ten minutes. Applications can also register action classes. The owner receives a one-time checker credential. The application exchanges a code, rotates the refresh credential and checks each action against POST /v1/delegation/check. A repeated refresh revokes its grant. POST /delegate/status checks identity-only delegations, including those issued by a recently retired key. Owners rotate the signing key with POST /admin/delegation/signing-key/rotate.

## Browser acceptance

After a production build, run `npm run test:browser` with Chromium installed. Set `CHROMIUM_PATH` if the binary is outside /usr/bin/chromium. The check starts an isolated temporary vault and requires the configured broker port to be free. It exercises login, a sealed provider credential, issuance of a scoped grant, mobile search and source download.

## Integration workflows

- Choose **Authorize with Notion** when adding a Notion connection. Register the exact console callback ending in `/api/oauth/notion/callback`. The credential owner can refresh a stored OAuth grant with `POST /admin/connections/{id}/oauth-refresh`.
- Set the allowed template directories on each HubSpot connection. Each directory must end with a slash. Draft upload checks the exact UTF-8 file digests. Publish rereads the draft files, checks their canonical bundle digest and asks for a separate approval.
- On a relay-enabled broker, call `OpenPassword.uploadYouTube(session, blob)` with the authorized connection, upload URL, relay seal, media type, size and SHA-256. The client verifies the file before querying the provider's accepted range through the broker. Keep the session receipt in private storage to resume after a restart.
- `@openpassword/client/publishing` exports `PublishingJournal` and `composePublishingTarget`. Store the SQLite journal in a private application directory. Save a revision, approve its digest, then drive `tick` on a schedule. Its transport takes a scoped broker request. Use an asset resolver that verifies the manifest's digest and returns the selected media reference. After a lost reply or process interruption, recover and resume the original request and idempotency key. The broker remains responsible for provider-side approvals. The publishing test is an executable example.
- An owner can register a Loops or Twilio signing secret using `POST /admin/webhooks` with `connection_id` and a sealed secret from the intake workflow. Configure the returned HTTPS callback with the provider. Read the encrypted delivery inbox via `GET /admin/webhooks/{id}/events?after=0&limit=50`. The cursor is the sequence of the last delivery. Revoke with `DELETE /admin/webhooks/{id}`.
- Use `@openpassword/connectors/local` for local media and notebook operations, `@openpassword/connectors/webhooks` for signature verification, and `@openpassword/connectors/x-thread` for digest-bound X thread planning.

## Linux service identities

The two systemd units in deploy/systemd run the broker and console under separate dynamic users. Place the built tree in /opt/openpassword/releases/<version>, readable by both services, and point the root-owned symlink /opt/openpassword/current at it (switch the symlink to roll back), with no system Node needed: the release bundles Node.js under `node/bin/node`, which the units run by absolute path. Install the units in /etc/systemd/system. The broker owns its private state directory. Set OPENPASSWORD_WEB_ORIGIN in a broker unit override to the externally visible console origin before enabling the services. For an existing instance, migrate the vault and its installation key during an offline maintenance window. Set up and verify HTTPS routing for your domain before connecting remote clients.



### Issue bundles and dispatch controls

Enroll a HubSpot connection with the selected resource `/rasa-newsletter/` and each permitted template directory. Issue the device a grant for `hubspot.files.upload_bundle`. Stage each image at `POST /v1/hubspot/issue-assets` with its original media type and the query fields `connection_id`, `file_name` and `sha256`. Invoke the operation with the returned file manifests, issue ID and bundle digest. The owner can review the upload destination, draft changes and exact manifest before dispatch. Read durable per-step receipts at `GET /v1/hubspot/issues/:id?connection_id=…`. Each issue ID can be reserved once per connection. The public service uses explicit workspace, connection, grant and folder selection in place of the private deployment’s hard-coded organization and portal.

Workspace owners can pause a single operation under **Workspace → Provider dispatch controls**. An upgrade from v0.1 expires outstanding YouTube relay proofs because they lack the operation identity needed for pause enforcement. Request a fresh upload session for an interrupted relay. Revolut transaction reads now require a selected account ID, including the legacy list alias. Supabase table selection permits columns from the selected table and explicitly scoped row writes.

### Personal profiles and sign-in methods

At first launch you can also expand **Create administrator with social sign-in**. Enter the installation setup code and the provider's OAuth web application credentials. Successful authorization creates the owner profile. A password is optional.

Under **Workspace → My profile**, owners, editors and viewers can add or change their username and password, link a configured Google, GitHub or Apple account, and remove individual methods. Each identity belongs to one profile. Linking requires a signed-in session. A workspace member can use their issued access token to enroll. The owner's **Authentication** settings configure the provider applications for the installation. Removing a provider is blocked if a profile depends exclusively on it.

For Apple, configure a Services ID, register the HTTPS domain and the displayed return URL in Apple Developer, and enter a signed Apple client-secret JWT. Rotate the JWT before expiry using the same Services ID. Local installations need a registered HTTPS domain for Apple. Password sign-in works on loopback.

### Credential ownership and sharing

Each workspace is an organization boundary. **Connections** lists the provider accounts you can use, with their source: **Organization**, **Owned by you**, or **Shared by** a named owner. The grant picker uses the same connections. Agent access uses scoped, expiring device tokens; the provider secret stays in the broker.

Only the administrator can add an organization credential. It is available to the entire workspace. Any active member can add a personal credential, which starts private. The owner can use **Edit access** to rename it and share with specific active people or everyone in that workspace. Rotation and revocation belong to the credential owner; the administrator manages organization-owned credentials. Sharing a personal credential with everyone preserves its personal ownership.

Removing someone's access invalidates agent grants they issued for that credential. Restoring sharing requires a new grant. Removing a member invalidates grants issued by that member and grants against that member's personal credentials. Existing installations migrate previously workspace-wide connections to organization ownership. Sign-in methods and human vault items use their existing access rules.

### Credential and sharing expiry

Set **Credential expiry** when connecting a provider or later under **Connections → Edit access**. A blank field gives the connection no OpenPassword deadline. For named sharing, each recipient has a separate deadline. **Whole-organization sharing expiry** limits organization-wide access. The owner retains access until the credential itself expires. All fields accept a UTC date and time and include an **In 7 days** shortcut.

A device grant ends at the earliest of its requested expiry, the credential deadline, and its issuer’s applicable sharing deadline. Shortening a deadline caps existing grants. Extending it permits new grants without extending previously issued ones. These deadlines control use through OpenPassword. A provider can expire or revoke its underlying key independently.

### Consumption

Open **Consumption** to inspect provider requests by credential or agent grant, with a period selector and paginated event history. Usage is attributed to the grant the caller presents. Give each agent a distinct grant when you want separate permissions or usage history. The issuing profile sees its usage; credential owners can also see consumption through their credentials. Organization-owned connections are visible to the administrator.

The SQLite ledger records each outbound HTTP attempt made by a brokered connector operation, model chat completion or YouTube upload relay before dispatch. Each attempt retains the timestamp, credential ID and revision, provider, device grant and label, issuing profile, operation and outcome. Retries that contact a provider count again. Cached replays and broker-only requests add no upstream event. A crashed or incomplete attempt remains visible with an unresolved outcome. A successful HTTP status describes the upstream response; it does not prove a billable operation completed.

Model usage is captured from JSON and streaming usage frames even without a tariff. Optional grant tariffs calculate USD estimates from reported usage. The report joins existing settlement and reconciliation records and shows unsettled reservations separately. Missing usage or pricing remains unpriced. Counts and totals begin with deployment of the ledger. The deployment's existing vault backup includes the ledger. Provider invoices, native Claude Code/Codex sessions and API calls outside the supported broker routes require separate ingestion.

## Release package

On a Linux host with Node 24.19.0 as the build Node (the release refuses any other version), `xz`, and network access to nodejs.org, check out the exact commit to release and run `make package COMMIT=<sha>`, then `make checksum`. `make package` refuses a dirty tree or a different HEAD, builds that commit in a scratch directory from `git archive`, keeps only production dependencies and the runtime files, and writes `dist-release/openpassword-<version>-linux-<arch>.tar.gz`, `RELEASE.json` (commit, tree, Node version and binary hash, lockfile sha256, source epoch) and a completion marker. `make checksum` writes the `.sha256` sidecar only for an archive that matches its marker and `RELEASE.json`. Two builds of the same commit and toolchain are reproducible except for the per-build files listed in `scripts/per-build-files.txt` and in `RELEASE.json` (`per_build_files`): Next.js generates a secret server-reference key on every build, which must differ per build and is never made deterministic. `make package` also writes `<name>.manifest`, the sha256 of every other file, and `scripts/compare-builds.sh <dirA> <dirB>` compares two manifests. Build diagnostics (`.next/trace`, `.next/diagnostics`, `.next/cache`) are not shipped. It includes built output and installed dependencies, so build it on the target architecture. ffmpeg and Chromium are not included.

`make package` refuses to build when `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set in the environment, because Next.js embeds a caller-supplied key in the build output; the generated key stays random per build. It also refuses unless every per-build file exists as regular files in the staged release. The only per-build paths are `.next/server/server-reference-manifest.json` (the generated key described below; its `.js` companion showed no variance and is compared) and `.next/server/preview-props.json` and `.next/prerender-manifest.json` (Next's random preview-mode keys, diagnosed in the 4fd28b31 gate diff). `make package` builds in the fixed directory `/tmp/openpassword-release-build` and refuses if it exists, before changing anything, and holds it until the build ends; the directory and `dist-release/` are created owner-only (0700) because they hold per-build key material. It builds there because Next embeds absolute build paths and derives module ids from them, which made two builds in different checkouts differ (also diagnosed in that diff); the first two-build run must confirm they are the only legitimate differences. The server-reference files hold the key Next generated for that build, which the server needs at run time to encrypt Server Action closures. It is random, belongs to no operator, and protects no credential or vault data. Do not substitute your own key at build time. No server action exists in the source today, so that key protects none. `make package` also refuses to build if `app`, `server` or `packages` mention Server Actions or preview/draft mode (`use server`, `draftMode`, `setPreviewData`, `previewData`, `__prerender_bypass`). **The release archive is not a public download.** It also contains Next's random preview-mode values, which the locked Next.js runtime loads at run time; a public archive would disclose the same values to everyone running that build. Do not attach it to a public release. It stays in gate custody and installs are made from there, until a distribution design with per-install keys, or with the framework behaviour disabled, has been qualified. This is the maintainer's reading of Next.js behaviour and is unverified until the gate inspects the built archive.

To install, save this as a Bash script (it stops at the first failure). Set `VERSION` and `ARCH` (for example `VERSION=0.3.0 ARCH=arm64`), `ARCHIVE` to the archive's path, `EXPECTED_SHA256` to the archive digest and `EXPECTED_COMMIT` to the commit recorded by the party that gated it. Archive digests differ between builds, because Next generates a per-build key, so the gate record must name the one build it published and that archive's sha256; the digest is not a property of the commit. Do not take the digest from a sidecar next to the archive. The script copies the archive into a root-owned 0700 staging directory, verifies that staged copy, and extracts only that copy. The archive in your own directory is read once, by the copy.

```bash
set -euo pipefail
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "$ARCH" =~ ^[a-z0-9_]+$ ]] && [[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] && [[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
  || { echo "VERSION, ARCH, EXPECTED_SHA256 or EXPECTED_COMMIT is malformed" >&2; exit 1; }
case "$(uname -m)" in aarch64|arm64) HOST_ARCH=arm64 ;; x86_64) HOST_ARCH=x64 ;; *) HOST_ARCH=$(uname -m) ;; esac
[ "$(uname -s)" = Linux ] && [ "$ARCH" = "$HOST_ARCH" ] || { echo "ARCH $ARCH is not this Linux host ($HOST_ARCH)" >&2; exit 1; }
R=/opt/openpassword/releases
sudo mkdir -p "$R"
if sudo test -e "$R/$VERSION"; then echo "release $VERSION already exists" >&2; exit 1; fi   # never overlay a release
STAGE=$(sudo mktemp -d /opt/openpassword/.stage-XXXXXX)   # root-owned, mode 0700
NEW=
trap 'sudo rm -rf "$STAGE" ${NEW:+"$NEW"}' EXIT
sudo cp -- "$ARCHIVE" "$STAGE/release.tar.gz"
GOT=$(sudo sha256sum "$STAGE/release.tar.gz" | cut -d' ' -f1)
[ "$GOT" = "$EXPECTED_SHA256" ] || { echo "digest mismatch: $GOT" >&2; exit 1; }
NEW=$(sudo mktemp -d "$R/.new-XXXXXX")
sudo tar -xzf "$STAGE/release.tar.gz" -C "$NEW" --no-same-owner
sudo chmod 755 "$NEW"
for f in server/main.ts node_modules/next/dist/bin/next packages/cli/dist/index.js .next/BUILD_ID \
         node_modules/tsx/package.json node/bin/node .next/server/server-reference-manifest.json .next/server/server-reference-manifest.js; do
  sudo test -f "$NEW/$f" || { echo "missing $f in the release; not switching" >&2; exit 1; }
done
# Probe under the units' own sandbox (identity and restrictions), with the Node that ships in the release.
SD="sudo systemd-run --quiet --pipe --wait --property=WorkingDirectory=$NEW -p DynamicUser=yes -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes"
# The release must be the one named: RELEASE.json comes from the verified, extracted copy.
$SD "$NEW/node/bin/node" -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1] + "/RELEASE.json", "utf8"));
const [v, a, c] = process.argv.slice(2);
if (r.name !== "openpassword" || r.platform !== "linux" || r.version !== v || r.arch !== a || r.commit !== c) { console.error("RELEASE.json does not match", JSON.stringify([r.version, r.arch, r.commit])); process.exit(1) }
' "$NEW" "$VERSION" "$ARCH" "$EXPECTED_COMMIT" || { echo "release identity mismatch; not switching" >&2; exit 1; }
V=$($SD "$NEW/node/bin/node" -p process.version)
[ "$V" = v24.19.0 ] || { echo "service Node is $V, not v24.19.0; not switching" >&2; exit 1; }
# Broker: the tsx loader, and read access to its entry point.
$SD "$NEW/node/bin/node" --import tsx -e 'require("fs").accessSync("server/main.ts", require("fs").constants.R_OK)' \
  || { echo "broker loader or entry point is not usable under the unit sandbox; not switching" >&2; exit 1; }
# Web: the launcher itself.
$SD "$NEW/node/bin/node" node_modules/next/dist/bin/next --version >/dev/null \
  || { echo "web launcher is not usable under the unit sandbox; not switching" >&2; exit 1; }
sudo mv -T "$NEW" "$R/$VERSION"; NEW=
sudo ln -sfn "releases/$VERSION" /opt/openpassword/current.new
sudo mv -T /opt/openpassword/current.new /opt/openpassword/current   # atomic switch
```

Then restart the services (stop web before broker, start broker before web). The archive root is the release directory, so `server/main.ts` and `node_modules/next` sit directly under `/opt/openpassword/current`, the units' working directory.

**Moving from 0.2.0 to 0.3.0.** The 0.3.0 units run `/opt/openpassword/current/node/bin/node`, which the 0.2.0 archive does not contain, so the unit files and the release change together. Before switching the symlink, keep a copy of the units now installed (`sudo mkdir -p /opt/openpassword/units-0.2.0 && sudo cp /etc/systemd/system/openpassword-*.service /opt/openpassword/units-0.2.0/`). After the symlink switch, install the new units and reload: `sudo install -m 0644 /opt/openpassword/current/deploy/systemd/openpassword-broker.service /opt/openpassword/current/deploy/systemd/openpassword-web.service /etc/systemd/system/` and `sudo systemctl daemon-reload`, then stop web, restart broker, start web. A host that has no system Node needs the new units for the services to start at all.

**Rolling back.** Between releases that both bundle Node (0.3.0 and later) it is the symlink alone: point `current` at the previous release and restart. Rolling back to 0.2.0 crosses the boundary: the new units cannot start without `node/bin/node`. Stop web then broker, restore the saved 0.2.0 unit files into `/etc/systemd/system/`, make sure Node v24.19.0 is installed on the system PATH (the 0.2.0 units use it), run `sudo systemctl daemon-reload`, point `current` at the 0.2.0 release, then start broker and web. The packaging gate does not exercise the systemd transition or either rollback; do them first on a host you can afford to break.
