# Replacement status

This is a working 0.3.0 candidate. Earlier deployments of the predecessor service still have capabilities and wire contracts that this version does not fully implement. The names in the provider directory identify executable adapters. They do not establish method-for-method parity or vendor certification.

The comparison baselines are the predecessor service at b83b7f7ce30e10521cfdc4fa6e81352a3e771b04 and its integrations library at 4647f2cd9f79dbbcd168165d719f6ba1173f05f6. The inventories below describe the exported source. Unbuilt proposals in the reference integration backlog are separate from shipped Python functionality.

The differential runner finds all 40 operation IDs from the upstream default catalog in the 172 registered actions across 25 provider entries. This compares names. A separate 95-case reference corpus checks specific behavior.

## Broker and console

| Area | Implemented and exercised | Remaining differences |
|---|---|---|
| Custody | AES-256-GCM data envelopes with per-write keys, wrapped by the installation key; record-bound authenticated data; restart and rotation; browser-sealed provider intake; separate human-readable vault items. | Local file key custody, one broker process and same-origin console proxy. The private deployment's separate database identities, managed key lifecycle and migration tools need equivalent Linux deployments. |
| Tenancy and identity | Owner, workspace-scoped editors and viewers, authenticated sessions, opt-in action and identity-only browser delegation with PKCE and Ed25519, isolated grants and encrypted credentials. | Enterprise identity federation, upstream membership migration, SSH identity, certificates, runtime identity and service-specific trust chains. |
| Device transport | Version negotiation, single-use pairing, access and refresh rotation, revocation, connection discovery, operation capabilities, expected binding and durable idempotency. | Availability is a smaller projection. Capability, fence precedence and failure-marker compatibility still require the entire upstream conformance suite. The CLI's SQLite identity lock serializes local refreshes. |
| Approvals | Exact argument previews; replay after restart or pause; revocation; bounded standing Loops creation and HubSpot fills, immutable newsletter/template previews and bundle digests. | Remaining standing draft operations, historical approval migration and signed connector updates. |
| Gmail | Actual golden response shape, digest and artifact bytes; selected-label page reads, continuation and expiring encrypted artifacts. | Complete upstream error classification, retry behavior, cross-version continuation encoding and all artifact expiry/retention edge cases. |
| Loops contact imports | Manifest, selected list, workflow checks, bounded digest-verified chunks, shared dispatch pacing, 429 handling, upstream normalization and approval view validation, durable claims and replay; simulated import exercised end to end. | Digest-bound decisions and attested interrupted-claim recovery are implemented. Historical batch transfer and live reconciliation remain open. |
| YouTube | Approved video, thumbnail and caption upload sessions; device/connection/revision-bound and size-limited optional relay; links suppressed on replays. | The Node client verifies content and resumes relay transfers. Direct provider transfer, cross-job reconciliation, OAuth renewal qualification and live media evidence. |
| Models | Scoped chat grants for OpenAI-compatible endpoints, text SSE, quota reservation, exact model and token ceilings, duplicate suppression, audit and stop checks. | Integer micro-USD metering, held-charge reconciliation and tool calls are implemented. Provider invoice qualification, image generation, provider failover and provider-specific lifecycle remain open. |
| Operational controls | Pause, revoke, rotate, record actor and decision, persist execution outcome. | Workspace, provider and operation pauses are enforced. Escalation, reader databases, tenant-scoped retention/export and operational doubles remain open. |
| Web experience | Responsive workspace, search, grant builder, operator review, vault items, team roles, catalog and audit log. | Migration of historical deployment data and full UI/AX acceptance against the operator's existing estate. |
| GitHub identity | API-token reads, scoped read-only installation-token exchange and fixed GitHub operations. | Stage-C admission and seven Annex request fixtures verified. Configured role pins, response/feed projections and the complete PR identity workflow remain open. |

## Shipped integration families

The TypeScript registry is authoritative for exact callable operation IDs, arguments and fixed destinations. Each descriptor has a request-construction check. Only the workflows named in the test suite have end-to-end provider simulations.

| Reference family | Coverage in this release | Examples of remaining depth |
|---|---|---|
| Google Calendar, Docs, Drive, Gmail, Sheets, Slides, YouTube | Scoped HTTP operations, Google OAuth, selected Sheets resources, Gmail golden artifact and YouTube session/relay. | Full Drive content/permission workflows, wide payload and scope coverage, multi-account consent lifecycle, all YouTube job recovery/retention. |
| GitHub, Reddit | Repository, release and listing operations; bounded source reads, content digest and transient-body replay behavior. | End-to-end GitHub installation lifecycle, precise read projection/error corpus and live qualification of application-only Reddit mint. |
| HubSpot, Kit, Loops | CRM/email reads and draft operations, subscriber projection, campaign creation and manifest-bound Loops imports. | HubSpot draft creation/fill and template upload/publish are implemented. Issue bundles support encrypted staging, issued-image checks, per-step receipts and approved draft substitutions. Loops supports message, audience and upload completion. Remaining work includes theme lifecycle, Kit sequences, reviewed sending and state reconciliation. |
| Bluesky, Mastodon | Profiles, feeds, AT Protocol record creation and status publication. | Bluesky recovery/facets and discovery of arbitrary Mastodon instances. |
| Publishing | X, Threads, Facebook, Instagram and LinkedIn operations behind scoped grants and write approval. | Durable multi-step journal, Meta/TikTok composition and X thread planning are implemented. Native large-media uploads, per-network reconciliation and legacy operation-name compatibility remain open. |
| Telegram and Twilio/WhatsApp | Telegram updates, send and callbacks; Twilio message list/send; reusable Twilio webhook signature verification. | Full bot update object models, inbound event routing, media lifecycle and application gateway contracts. |
| Revolut Business | Read-only, selected account IDs, bounded transaction pages, exact decimal lexemes for money. | Accounts, transactions, expenses, receipt bytes and labels have bounded projections. Dedicated bank credential enrollment/refresh, migration and provider venue qualification remain open. |
| Supabase and Notion | Supabase project, selected-table reads/inserts; Notion pages, blocks and users. | Supabase realtime subscriptions, object storage, auth lifecycle; Notion OAuth and refresh are implemented. Scoped Supabase row upsert, update and delete are implemented. Full file operations remain open. |
| Briefing sources | Fixed weather, aircraft and exchange-rate request builders. | Reference-specific response projection, cache, budget and media-type coverage. |
| FFmpeg and Jupytext | Local typed media probe, H.264, audio and thumbnail helpers; percent-script and notebook conversion. | The percent-format path has semantic receipts and directory conversion. Other Jupytext formats and extended FFmpeg metadata/receipts remain open. |
| Webhooks | Raw-byte Loops HMAC and Twilio URL/form verification, including negative signature tests. | Loops and Twilio have signed callback routes, durable encrypted event storage and replay handling. Full application-specific event routing, retention policy and live retry qualification remain open. |

## Evidence required for replacement

Run `make verify` from a clean checkout. Qualify the Linux ARM64 service with real test tenants and separately authorize each live effect. Port the remaining legacy caller tests, including negative fixtures, to the public wire interface. Compare provider results, error markers, selected-resource restrictions, expiry and replay behavior before moving an existing consumer. No upstream provider calls, public deployment, production cutover or ARM64 machine qualification were performed in the council workspace.

### Public wire differences

Application registration uses an owner API and a separate activation action. Action-class grants, rotating refresh families, the action-check endpoint, identity grant status and a raw Ed25519 key document are implemented. Issuer and human issuer are derived from the deployment origin. The legacy issuer pins, organization membership records and private keys need an explicit migration before use with existing relying parties. The JWK document is available separately. The protocol header is optional for model client and action-check endpoints.

### Executed reference corpus

The optional reference runner compares the original files in place. It checks 39 batch approval views, 38 ordered email-normalization cases, 11 approval snapshots and template-bundle fixtures, and 7 GitHub Annex request fixtures. Snapshot fixtures compare the complete structured value and its digest. A matching fixture establishes that case only. The broader Python test suites, including live deployment contracts, are outside this count.
