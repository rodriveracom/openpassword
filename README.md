# OpenPassword

**An open-source credential manager for model routing and agentic tools.**

Give Claude Code permission to read a GitHub account for a week. Let an application call a specific model through your OpenAI account with a spending limit. In both cases, the provider key stays on your server. Each client gets its own access token, permissions, and usage history.

OpenPassword runs on your laptop or a Linux server. Applications and agents can use the HTTP REST API, local CLI or MCP. Python and TypeScript clients are also available. Applications can route model calls through the OpenAI-compatible Chat Completions API.

| I want to… | Start here |
| --- | --- |
| Show a company how shared logins work | [Three-minute team demo](docs/company-demo.md) |
| Try OpenPassword on my machine | [Start locally](#start-locally) |
| Call OpenPassword directly from a service or script | [HTTP quickstart and API reference](docs/http-api.md) |
| Connect a coding assistant, Python framework or Rasa action to a local CLI | [Native harness integrations and examples](examples/harnesses/README.md) |
| Give Codex or Claude Code an MCP tool | [Connect an agent](#connect-an-agent) |
| Make a model request from my app | [Route a model request](#route-a-model-request) |
| Run the server in the cloud and the agent on my laptop | [Deploy on a server](#deploy-on-a-server) |

For vault key custody, signed releases, CLI deposits and the findings from the security review, see [SECURITY.md](SECURITY.md). To set up passkeys, encrypted human sharing, recovery kits, device unlock or a separately hosted model gateway, follow [Security operations](docs/security-custody.md).

## Start locally

From the root of a cloned or extracted copy of this project, with **Node.js 24 LTS**, **npm**, and **Make** installed:

**Run as:** your own account · **Where:** the project root on your computer; leave `make dev` running · **sudo:** no

```sh
make setup
make dev
```

1. Open **http://localhost:3000**. The first visit shows **Set up your team vault**. Choose **On this computer** and **User installation**.
2. As the same account, in the project root, run `node public/openpassword-cli.cjs setup-code` in a second terminal (no sudo). The ten-minute code is for creating the first administrator.
3. Enter the code, select **Continue to account**, choose a username and password, and create your account. First-time setup closes as soon as the administrator exists. Google, GitHub, and Apple sign-in are optional.

The administrator lands on **Team overview**. Choose **Add shared login** to store a team account, add a teammate and check their access record.

To connect an application or agent, add a **connection**, a named provider account whose credential OpenPassword stores. A **grant** gives one client permission to use that connection for selected operations and a limited time. Choose either walkthrough below.

## Personal vault and approved agent hosts

For a personal password or API key, open **Private vault**, generate and confirm your saved key, choose a separate vault passphrase, and add the item there. **Delegate to gateway** creates a separate provider connection only when you authorize a copy.

Run `openpassword host connect` as the dedicated host service account on the agent machine, and `openpassword pair` as each agent's own account; the [host instructions](docs/operations.md#enroll-an-agent-host-and-approve-its-agents) say which steps need sudo. For a machine that runs several agents, issue a **host enrollment token** under Workspace, then run `openpassword host connect` on that machine and start its signing bridge. Each agent runs `openpassword pair` through the bridge. Approve each request under Access grants with its own connection, operations and expiry. New workspaces require host approval. Existing standalone workspaces switch when their first host enrolls. Follow the [host installation and agent enrollment instructions](docs/operations.md#enroll-an-agent-host-and-approve-its-agents).

## Connect an agent

For a workspace using standalone grants, this walkthrough lets a coding agent read your GitHub profile. You need a GitHub token that can read the authenticated user, plus Codex or Claude Code installed on the machine where you run the agent.

**1. Connect GitHub.** In **Integrations → GitHub → Connect account**, give the connection a recognizable name, enter your GitHub username as the account identity, and enter the provider token. Choose **Me** to keep the connection private. Save it.

**2. Connect the local CLI.** The client machine needs Node.js 24 or newer. Your web server serves a standalone CLI, including its MCP tools. In the web app, open **Access grants → Issue grant**, choose the GitHub connection, select `github.user.get` and set an expiry. Choose **One-time CLI enrollment token**. On the client, run:

**Run as:** the OS account that runs the agent · **Where:** the client machine, in a verified release checkout · **sudo:** no

```sh
export OPENPASSWORD_BROKER=https://vault.example.com
export OPENPASSWORD_AGENT=my-codex
# From a verified release checkout, use its trusted installer and manifest.
# Set OPENPASSWORD_CLI_SHA256 to the public/openpassword-cli.cjs digest from that release.
: "${OPENPASSWORD_CLI_SHA256:?Set the independently verified release digest}"
export OPENPASSWORD_CLI_SHA256
sh deploy/update-client.sh
export PATH="$HOME/.local/bin:$PATH"
openpassword connect
openpassword whoami
openpassword capabilities
```

Use your installation’s HTTPS address, or `http://localhost:3000` when the server runs on this computer. Paste the token at the hidden prompt. The token can be redeemed once within ten minutes. Compare the returned device ID with the grant in the console. The profile is scoped to this broker and agent name. The CLI stores the profile locally, and the server checks grant validity on requests. Keep separate OS accounts for agents that must be isolated from one another.

**Fetch an artifact.** An operation that returns its result as an artifact (for example a Gmail page read) reports an `artifact_id` and a `content_sha256`. Run `openpassword artifact ART_ID [SHA256]` to write the artifact's exact bytes to standard output; with the digest it verifies them first and writes nothing on a mismatch. The artifact is valid for fifteen minutes and only for the grant that produced it.

**Watch activity.** Open **Activity** at `/activity` for live workspace activity visible to you. Use `openpassword watch` for events from this CLI grant, or `openpassword activity` for a snapshot. MCP exposes `whoami` and `activity` through the same profile.

**3. Register the tool server.** Run the command for your client in the same terminal, after pairing finishes.

The examples below assume one private harness configuration per agent. For a shared harness configuration, keep profile selection in a launcher that verifies the calling identity and exits if it cannot identify it.

**Codex**


**Run as:** the same account · **Where:** the same terminal on the client machine · **sudo:** no (both commands below)
```sh
codex mcp add openpassword \
  --env OPENPASSWORD_BROKER="$OPENPASSWORD_BROKER" \
  --env OPENPASSWORD_AGENT="$OPENPASSWORD_AGENT" \
  -- "$HOME/.local/bin/openpassword" mcp
```

**Claude Code**

**Claude Code user · agent workstation · no sudo**

```sh
claude mcp add --scope user --transport stdio openpassword \
  --env OPENPASSWORD_BROKER="$OPENPASSWORD_BROKER" \
  --env OPENPASSWORD_AGENT="$OPENPASSWORD_AGENT" \
  -- "$HOME/.local/bin/openpassword" mcp
```

**4. Make the first call.** Open your coding agent and ask:

> Use OpenPassword to list my connections and permitted operations. Then use my GitHub connection to tell me my GitHub username.

The agent can discover and invoke the read operation you selected. Open **Consumption** to see the upstream request. To check pairing directly from the terminal, run `openpassword connections`. To end access, revoke the grant in **Access grants**.

The MCP connection gives the agent tools. The coding client continues to use its own configured model for inference.

## Route a model request

OpenPassword routes each model grant to **one provider connection and one exact model ID**. Supported upstreams are OpenAI, OpenRouter, and Moonshot. Clients can discover their authorized model through `GET /v1/models` and use `POST /v1/chat/completions` for text, streaming responses, and tool calls.

On an enrolled host, use the [host-signed HTTP example](docs/http-api.md#try-the-api) and run `node examples/http/agent.ts chat`. The bearer-only Python walkthrough below applies to workspaces that allow standalone grants.

1. Add your provider under **Connections**. For this example, choose OpenAI and enter your provider API key.
2. In **Access grants → Issue grant**, name the client, select the connection, and enable `openai.chat`. Under **Standing model access**, enter a model ID available to your provider account, permit at least one request, and allow at least 32 output tokens. You can also set a monetary budget using the provider’s rates.
3. Choose **API access and refresh tokens**, leave the pairing code blank, issue the grant, and copy its **access token**. The following Python 3 example prompts for that token without echoing it, discovers the authorized model, and makes one request.

**Run as:** any account · **Where:** the machine running your application · **sudo:** no

```python
import getpass
import json
import os
import urllib.request

base = os.environ.get("OPENPASSWORD_BROKER", "http://localhost:3000").rstrip("/")
token = getpass.getpass("OpenPassword access token: ")

def api(path, body=None):
    request = urllib.request.Request(
        base + "/v1/" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)

model = api("models")["data"][0]["id"]
reply = api("chat/completions", {
    "model": model,
    "messages": [{"role": "user", "content": "Say hello in one sentence."}],
    "max_tokens": 32,
})
print(reply["choices"][0]["message"]["content"])
```

For an enrolled CLI with a model grant, use `openpassword models` to list its models. Send a prompt with `openpassword chat MODEL MAX_TOKENS REQUEST_KEY < prompt.txt`. Use a unique key for each intended call. MCP exposes the same operations as `models` and `chat`.

A successful call prints the model’s reply. Open **Consumption** to see the model, request, and reported token counts. With pricing configured, you also see estimated spend. Requests without pricing are marked **Unpriced**. For a long-running client, use the grant’s refresh token to renew access; the paired CLI handles renewal automatically.

## Deploy on a server

The Linux console and broker listen on loopback. Expose the required public API paths through your own HTTPS reverse proxy. Keep the console accessible through the operator's private route. Serve signed CLI assets to approved client machines. Set OPENPASSWORD_WEB_ORIGIN to the canonical HTTPS origin used in host proofs.

1. **Release operator · gate host · no sudo.** Build and verify one exact commit, its signed CLI and its release digest. Follow the signing and packaging commands in [SECURITY.md](SECURITY.md).
2. **Deployment operator · production server · sudo required.** Install the verified archive with the one-command updater in [operations](docs/operations.md#upgrade-a-running-systemd-installation).
3. **First administrator · own workstation · no local sudo.** Run `openpassword setup-code --ssh user@server` with a verified SSH alias. A system service requires remote permission to read the operator credential. A per-user service supports `--user`. Open the private console, enter the short-lived code and create the account. Human onboarding works before any agent exists.
4. **Host administrator · agent host · service account.** After account creation, generate a host ticket in Workspace and follow the [host enrollment instructions](docs/operations.md#enroll-an-agent-host-and-approve-its-agents). Agents request separate grants.

For a private trial over SSH, on your laptop as your own account (no sudo), forward the console with `ssh -N -L 127.0.0.1:3000:127.0.0.1:3000 user@server` and use the local quickstart URLs while the tunnel is open.

## Share access and track usage

| Control | How it works |
| --- | --- |
| Ownership | Administrators manage organization credentials. Personal credentials start private. Their owners can rotate them and share access with named people or the whole workspace. |
| Expiry | Set a deadline for the credential itself, an individual recipient, or organization-wide sharing. A grant ends at the earliest applicable deadline. |
| Approvals | For a tool call requiring approval, review the operation and arguments in **Approvals**. The client retries with the same request key to obtain the result. |
| Consumption | Inspect upstream requests by credential or agent grant. Revocation stops future access and preserves the request history. |
| Human sign-in | Link Google, GitHub, Apple, or a password under **Workspace → My profile**. Configure installation-wide sign-in providers under **Workspace → Authentication**. |

## Operate and contribute

OpenPassword stores encrypted provider credentials, grants, and usage history in SQLite. The encryption key lives in a separate file on the server. For a restorable offline backup, stop the service and copy the **entire data directory**, including `master.key`, preserving permissions. The default location is `~/.openpassword`; use `OPENPASSWORD_HOME` to choose another.

- [Provider and deployment reference](docs/operations.md) — OAuth callbacks, connector setup, backups, service configuration, and integration workflows.
- [Contributing](CONTRIBUTING.md) — contribution terms and how to verify a change. In the project root, as your own account (no sudo), run `make verify` to build the packages, check types, run tests, and build the console.
- [Changelog](CHANGELOG.md) — project release history.

This candidate distributes the server, console, first-party packages and examples under [AGPL-3.0-only](LICENSE). Package license files retain notices for previously MIT-licensed material. Third-party assets retain their own licenses.

## Update an existing installation

For the supplied Linux services, on the server as root, install the exact gate-built archive using `sudo sh deploy/upgrade.sh --install ARCHIVE SHA256 VERSION COMMIT`. The updater checks readiness and restores the previous build on failure. On each workstation, as the account that uses the CLI (no sudo), `sh deploy/update-client.sh` updates the installed CLI using its configured broker address. [Upgrade and rollback instructions](docs/operations.md#upgrade-a-running-systemd-installation)
