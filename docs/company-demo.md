# Show a company OpenPassword in three minutes

Open with “Jane joins customer support today. How does she get into the support desk, how do we know she used it, and what happens when she leaves?”

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | Run the setup CLI as the installation operator. In the browser choose where the server runs, paste the short-lived code, and create the administrator. | “The person who controls this installation creates the first administrator. Jane will use her own sign-in.” |
| 0:30 | On **Team overview**, select **Add shared login**. Save **Support desk** with a synthetic account and password. | “The team now has one shared login. Personal credentials belong in Private vault.” |
| 1:00 | **Add teammate** → Jane → **Editor**. Hand Jane her member sign-in address and token privately. | “Viewer can see item metadata. Editor can reveal every shared login in this workspace and manage access. This role applies across the workspace.” |
| 1:30 | In Jane’s separate browser profile, sign in, open **Support desk**, select **Reveal**, then **Hide**. | “Jane signed in as herself. The vault can attribute this access to her.” |
| 2:00 | Return to the owner’s **Team overview**. Select **Check for access** if necessary, then **View item history**. | “Here is Jane’s access record. It proves a reveal in OpenPassword. The external support desk has its own sign-in history.” |
| 2:30 | In **Workspace access**, revoke Jane. Try **Reveal** again from Jane’s already-open item. | “Her current session is refused. Because she saw this password, we would rotate it at the support desk when offboarding her.” |

Use synthetic values throughout. For a real handoff, treat the member token as a reusable credential and deliver it privately. No provider account, agent host or OAuth client is needed for this demo.

## Rehearse or present from a clean workspace

**Presenter · local development machine · no sudo.** Use a checkout with Node 24, Go and the build tools described in the main README, plus a Chromium executable. From the project root:

```sh
make setup
npm run build
CHROMIUM_PATH=/path/to/chromium OPENPASSWORD_DEMO_LIVE=1 npm run demo:company
```

The demo opens Chromium, uses a temporary broker and two separate browser profiles, and pauses at six scenes. Press Enter in the terminal to advance. It removes the disposable vault when it finishes. The broker port baked into the console build (4141 by default) must be free. Leave your deployed instance running and rehearse on a separate development machine if needed.

For a headless rehearsal, omit `OPENPASSWORD_DEMO_LIVE=1`. Set `OPENPASSWORD_DEMO_CAPTURES` to an output directory to capture the six presentation scenes. The capture points omit setup codes, member tokens and revealed passwords.
