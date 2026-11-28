# Walkthroughs

Start OpenPassword first ([quick start](../README.md#quick-start)).

## Connect an agent

This walkthrough lets a coding agent read your GitHub profile. You need a GitHub token that can read the authenticated user, plus Codex or Claude Code installed on the machine where you run the agent.

**1. Connect GitHub.** In **Integrations → GitHub → Connect account**, give the connection a recognizable name, enter your GitHub username as the account identity, and enter the provider token. Choose **Me** to keep the connection private. Save it.

**2. Connect the agent.** How depends on the workspace. A **new installation** binds every grant to an enrolled host: use 2a. A workspace that still allows **standalone grants** (one that already had grants and has not enrolled a host) offers a one-time token: use 2b.

### 2a. New installation: enroll the machine, then pair

These commands are for a trial on the machine that runs OpenPassword, from the project root. For a separate or shared agent machine, follow the [host instructions](operations.md#enroll-an-agent-host-and-approve-its-agents), which run the signing bridge as its own service account.

In the web app, open **Workspace → CLI hosts**, name the machine and choose **Issue host enrollment token**. Then:

**Run as:** your own account · **Where:** the project root, in a second terminal; leave `host serve` running · **sudo:** no

```sh
export OPENPASSWORD_BROKER=http://localhost:3000
export OPENPASSWORD_HOST_HOME="$HOME/.openpassword-host"
export OPENPASSWORD_HOST_SOCKET="$HOME/.openpassword-host/bridge.sock"
node public/openpassword-cli.cjs host connect   # paste the token at the hidden prompt
node public/openpassword-cli.cjs host serve
```

**Run as:** the same account · **Where:** the project root, in a third terminal · **sudo:** no

```sh
make install-cli
export PATH="$HOME/.local/bin:$PATH"
export OPENPASSWORD_BROKER=http://localhost:3000
export OPENPASSWORD_HOST_SOCKET="$HOME/.openpassword-host/bridge.sock"
export OPENPASSWORD_AGENT=my-codex
openpassword pair
openpassword whoami
openpassword capabilities
```

While `pair` waits, open **Access grants → Issue grant**, name the agent, choose the GitHub connection, select `github.user.get`, set an expiry and pick the waiting request under **Requesting agent and approved host**. Refresh the page if the request is not listed. Keep the bridge running while the agent works, and add `--env OPENPASSWORD_HOST_SOCKET="$OPENPASSWORD_HOST_SOCKET"` to the registration command in step 3 (before the `--`). Agents under one OS account share a trust boundary.

### 2b. Standalone workspace: one-time token

The client machine needs Node.js 24 or newer. Your web server serves a standalone CLI, including its MCP tools. In the web app, open **Access grants → Issue grant**, choose the GitHub connection, select `github.user.get` and set an expiry. Choose **One-time CLI enrollment token**. On the client, run:

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

### Register and try it

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

**On a new installation** (host-bound grants), a copied token alone is refused. Enroll the machine and run `openpassword pair` as in [2a](#2a-new-installation-enroll-the-machine-then-pair), approving a grant for `openai.chat` with a model, then use `openpassword models` and `openpassword chat`, or the [host-signed HTTP example](http-api.md#try-the-api) with `node examples/http/agent.ts chat`.

**The steps below** use a bearer token with Python and apply only to workspaces that allow standalone grants.

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
