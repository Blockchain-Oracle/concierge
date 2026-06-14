# Concierge — Frontend Brief for Designer

> **What this brief is.** Everything you need to design Concierge's three
> user-facing web surfaces (landing, app, docs) plus every shared
> component, with full domain context so you can make confident design
> calls. It is intentionally exhaustive — nothing about the product is
> withheld.
>
> **What this brief is NOT.** It does not prescribe colors, typefaces,
> spacing scales, motion language, iconography, illustration style,
> elevation hierarchy, density choices, or any other visual decision.
> Those are yours. Wherever the rest of the project refers to design
> tokens (`@concierge/ui/tokens`), assume you own their values; the
> engineering side only owns their *names* and *categories*.
>
> **How to read it.** Skim §1–§4 to understand the product and the
> people who use it. Read §5 (information architecture) and §6 (user
> flows) carefully — these constrain the design more than anything
> visual would. §7–§9 walk every page on every surface. §10 catalogs
> every component. §11–§13 are the cross-cutting contracts
> (accessibility, responsive, data shape). §14 is the explicit list of
> design choices that are yours and yours alone.

---

## §1 — What Concierge is

Concierge is an autonomous AI agent that manages a user's DeFi position
on the Mantle blockchain, 24 hours a day. A user sets a goal in plain
English — "max stablecoin yield, never breach 70% Aave LTV, keep $200
USDC liquid" — and an agent owned by that user runs a continuous loop
that:

1. **Plans** the next action (LLM picks one of ~30 available DeFi
   actions across seven Mantle protocols, given the user's portfolio
   state, goal, and policy).
2. **Simulates** that action (dry-runs it against the chain, checks
   health-factor and slippage and other constraints).
3. **Proposes** it to the user as a structured card with reasoning and
   simulation output.
4. **Decides** — the user approves manually, or a session key
   auto-signs based on a per-category autopilot policy.
5. **Executes** the action on-chain via an ERC-4337 user-operation.
6. **Records** the result in a permanent on-chain receipt
   (ERC-8004 attestation) so the agent's track record is independently
   auditable forever.

This loop is called a **tick**. A tick runs every ~60 seconds by
default. Users watch the loop happen in real time. The LLM's reasoning
streams character-by-character into a card. A status pill animates
through the tick's lifecycle. The transaction hash links to a block
explorer the moment it confirms. The attestation hash links to the
on-chain reputation registry.

Concierge composes seven Mantle protocols (Aave V3, Mantle DEXes,
Ethena sUSDe, Ondo USDY, mETH staking, Li.Fi bridging, ERC-8004
reputation) under one agent. The user does not pick protocols; they
state a goal, and the agent picks across protocols to satisfy it.

The agent's identity is itself on-chain: each user owns an ERC-8004
identity NFT, and the agent's reputation accumulates against that NFT.
A `/agent/:id` route shows that reputation publicly, viewable without
authentication.

---

## §2 — Who uses it

### Primary persona — the DeFi user

Holds stablecoins (USDC), staking assets (mETH), or RWA yield tokens
(sUSDe, USDY) on Mantle. Wants the yield + flexibility of active DeFi
management without spending hours per week on it. Already knows what a
robo-advisor / autotrader / yield optimizer is. Wants something they
*own* (their session key signs every move) rather than a custodial
black box. Comfortable connecting a wallet. Reads tx hashes.

### Secondary persona — the Mantle developer

Building their own agent or app on Mantle. Wants to drop Concierge's
DeFi actions into an existing LangChain / Vercel AI SDK / OpenAI /
Claude Agent / Coinbase AgentKit stack with one `npm install`. Reads
the docs first, then the landing's developer CTA. Cares about API
shape, type safety, error handling, streaming contracts.

### Tertiary persona — the hackathon judge

Lands on the site cold. Has 30–90 seconds to decide whether this
project is worth a longer look. Will not read a wall of text. Needs to
see the agent working before they click anything.

### Quaternary persona — the public reputation viewer

Someone an agent owner shared an `/agent/:id` URL with. Wants to see
the agent's track record (count, average value, recent history) before
they trust it (for delegated funds, vouching, recruitment).

---

## §3 — Brand voice + tone (non-visual)

- **The user is the principal; the agent is the steward.** The agent
  works *for* the user, never *at* them. Copy reflects this. "Your
  agent suggested X" not "AI recommends X."
- **Plain English, no marketing buzzwords.** "Set a goal" not "Unleash
  AI-powered autonomous DeFi optimization." "Approve" not "Confirm
  execution authorization." If a label could appear in an enterprise
  SaaS dashboard, rewrite it.
- **Calm + confident, not aggressive or hype-y.** This is finance.
  Trust comes from steady tone, not exclamation marks.
- **Functional honesty.** When something is loading, say "Loading the
  last 30 days of attestations." When something failed, say "Aave
  pool rejected this transaction. The borrow rate moved while we were
  simulating." Never "Oops! Something went wrong."
- **Numbers are sacred.** Show real numbers with units. "0.42 MNT" not
  "tiny amount of gas." If a number is approximate, say "~" and round
  consistently. Never display a wei value in scientific notation to a
  user.
- **No emoji in product chrome.** Emoji are fine in copy where they
  carry information (e.g., a status icon). Decorative emoji are not.

---

## §4 — The four surfaces (and which one this brief is about)

Concierge ships across four surfaces:

| # | Surface | Owns |
|---|---|---|
| 1 | **Web app at concierge.xyz** — landing, app, docs | THIS BRIEF |
| 2 | **npm SDK** — `@concierge/sdk` + 14 sibling packages | Engineering only |
| 3 | **MCP server** — installs in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code Copilot, Zed, Cline, Goose, OpenCode, Codex | Engineering owns transport; designer owns the embedded `ui://` HTML resources Claude Desktop renders inside the chat |
| 4 | **RealClaw skill** — `npx skills add @concierge/mantle-agent` | Engineering only |

This brief covers Surface 1 in full and the embedded HTML resources
within Surface 3 (described in §10 under "MCP UI Resources"). Surfaces
2 and 4 have no design surface beyond a one-page README's social card
which can come later.

---

## §5 — Information architecture

The web app at `concierge.xyz` has three logical surfaces (landing,
app, docs) and one public reputation viewer. Routes are locked.

### Public routes (no auth)

| Route | Purpose |
|---|---|
| `/` | Landing — the marketing surface. |
| `/agent/:id` | Public reputation viewer for any agent (shareable URL). |
| `/docs` | Docs home + table of contents. |
| `/docs/quickstart` | "Clone to running agent" in ~10 minutes. |
| `/docs/sdk` | `@concierge/sdk` API reference. |
| `/docs/providers` | Per-protocol reference (Aave, DEX, sUSDe, USDY, mETH, Li.Fi, ERC-8004). |
| `/docs/runtime` | Agent runtime concepts — tick loop, session keys, attestation. |
| `/docs/skill` | RealClaw skill packaging + install guide. |
| `/docs/mcp` | MCP server setup; one section per host (Claude Desktop, Claude Code, Cursor, Windsurf, etc.). |
| `/docs/recipes` | Copy-paste examples (yield optimizer, depeg-resistant treasury, autopay). |
| `/docs/architecture` | Full system diagram. |
| `/docs/contributing` | Open-source contributor guide. |

### Onboarding routes (wallet required, sequential)

| Route | Purpose |
|---|---|
| `/app/onboarding/connect` | Wallet connect (Privy / Reown / WalletConnect). |
| `/app/onboarding/account` | Smart account deploy (sponsored by Concierge — user pays zero gas). |
| `/app/onboarding/identity` | ERC-8004 identity NFT mint. |
| `/app/onboarding/goal` | First plain-English goal. |
| `/app/onboarding/policy` | Autopilot toggles per category. |
| `/app/onboarding/activate` | Final confirm + activation. |

### Authed app routes

| Route | Purpose |
|---|---|
| `/app` | Dashboard — agent stream + portfolio + emergency stop. |
| `/app/goal` | Edit active goal. |
| `/app/ticks` | Full tick history (paginated, filterable). |
| `/app/ticks/:tickId` | Single tick detail (reasoning, simulation, execution, attestation). |
| `/app/portfolio` | Position detail across all 7 providers. |
| `/app/agent` | Authed view of the user's own agent reputation. |
| `/app/settings` | Network selector, LLM model overrides, API keys, MCP install. |

### Headers + footers

The header has four variants — `landing`, `app`, `minimal`,
`docs`. The footer has three — `full` (landing), `minimal` (docs,
public reputation), and `none` (app routes — the emergency stop takes
the persistent role a footer would otherwise play). See §10 for
component intent of each.

The header is **always present**, including on every onboarding step.
Heights are locked at 64px desktop / 56px mobile. The landing header
is sticky after scroll and condenses. The app header is pinned.

---

## §6 — User flows

### Flow A — Cold landing → first tick (the demo moment)

1. User arrives at `/` from a tweet, judge link, or word of mouth.
2. Hero shows a real agent ticking live on Sepolia (status pill
   animating, reasoning streaming) — the proof of life. The user has
   not interacted yet.
3. User reads the wedge, scrolls down through HowItWorks → comparison
   framing → developer CTA → trust signals.
4. User clicks "Try on Sepolia" (primary hero CTA).
5. Routed to `/app/onboarding/connect`. Wallet prompt opens.
6. After connect: `/app/onboarding/account`. Concierge sponsors the
   smart-account deploy (Pimlico paymaster) — the user pays zero MNT.
   Progress indicator shows the deploy phases.
7. `/app/onboarding/identity`. ERC-8004 identity NFT mints. Card
   explains "This NFT is your agent's permanent identity. Every action
   your agent takes will accumulate reputation against it."
8. `/app/onboarding/goal`. Plain-English text area. Example goals
   carousel below the input (clickable to fill). LLM parses input as
   the user types and renders structured parameters as editable chips.
9. `/app/onboarding/policy`. Autopilot toggles per category (Aave
   actions, DEX swaps, Bridge, Yield, Restaking). Default all off.
   Spending caps (per-day, per-tx, per-category).
10. `/app/onboarding/activate`. Review screen + activate CTA.
11. Redirects to `/app`. First tick fires within 60s. User watches it
    stream.

### Flow B — Tick stream observation (the active session)

1. User on `/app` dashboard.
2. Server streams a state change via SSE: tick N+1 entering
   `planning`.
3. A new tick card slides into the top of the stream.
4. Status pill pulses `planning`.
5. Reasoning text streams character-by-character into the card body.
6. After plan complete: pill transitions to `simulating`. A nested
   simulation card renders inside the tick card with the dry-run
   output (expected USD delta, health-factor projection, risk flags).
7. After simulation: pill transitions to `proposing`. A nested action
   approval card renders with Approve / Reject / Edit controls.
8. **If the user has manual mode for this category:** an approval
   countdown begins (default 5 minutes — after which the action
   auto-rejects).
9. **If autopilot for this category:** pill skips straight to
   `auto-approved` → `executing`.
10. Execution card renders with the pending tx hash (links to
    MantleScan). Tx confirmation streams.
11. Final state: `attested`. The attestation card renders with the
    feedback hash linking to the on-chain reputation registry. The
    tick card collapses to a compact summary.

### Flow C — Manual approval

1. User sees a tick card in `proposing` state.
2. Reads the action summary ("Supply 100 USDC to Aave V3 — expected
   +3.4% APR, post-action HF 2.1").
3. **Either:**
   - Clicks Approve → pill transitions to `executing`. Flow continues
     as in Flow B steps 9–11.
   - Clicks Reject → pill transitions to `rejected-by-user`. Card
     collapses to a "Rejected at 14:23" summary. No on-chain action.
   - Clicks Edit → a modal opens with the action's tunable parameters
     (e.g., supply amount, max slippage). User edits, saves; the agent
     re-simulates with the new parameters and re-proposes.
4. If the user takes no action before the approval countdown
   expires, pill transitions to `rejected-by-user` automatically with
   "Timed out at 14:28".

### Flow D — Emergency stop

1. User clicks the Emergency Stop button (always visible in the app
   header on desktop, floating action button bottom-right on mobile).
2. Modal opens: "Stop all autopilot. Your existing positions remain.
   You can resume any time. The agent will not execute any new
   actions until you do."
3. User confirms.
4. On confirm:
   - All session keys revoked on-chain.
   - Autopilot policies set to off.
   - Cron schedule halted.
5. A persistent banner appears across the top of every `/app/*` route:
   "Agent stopped. Resume to schedule new ticks."
6. A "Resume" button in the banner re-issues session keys and restarts
   the schedule.

### Flow E — Reputation share

1. User on `/app/agent` (their own authed reputation view).
2. Clicks "Copy share link" → clipboard receives
   `https://concierge.xyz/agent/:id`.
3. Recipient opens that URL — unauthenticated.
4. Public reputation viewer renders: agent NFT, reputation summary,
   reputation chart, recent attested ticks (read-only, no controls).

### Flow F — Tick history navigation

1. User on `/app` clicks "View all ticks".
2. Routed to `/app/ticks`.
3. Paginated list (50 per page). Each row is a clickable tick card in
   its compact summary form.
4. Filter controls at top: status (all, confirmed, rejected, failed),
   provider (all, Aave, DEX, sUSDe, …), outcome (positive USD delta,
   negative USD delta).
5. User clicks a row.
6. Routed to `/app/ticks/:tickId` — single tick detail page with the
   full reasoning, simulation, execution, and attestation records,
   each as its own section.

### Flow G — Portfolio drill-in

1. User on `/app` sees a portfolio snapshot card.
2. Clicks "Full positions" → `/app/portfolio`.
3. One section per protocol with active positions.
4. Each position row: amount, USD value, APR (signed), health-factor
   contribution (Aave only).
5. Aggregated health-factor gauge at top across all Aave positions.
6. Net effective yield calculator showing weighted-average APR across
   all positions.

### Flow H — Goal edit

1. User on `/app` clicks the active goal card.
2. Routed to `/app/goal`.
3. Same goal input UI as `/app/onboarding/goal`, pre-populated.
4. User edits — LLM re-parses parameters live.
5. Edits autopilot toggles + spending caps.
6. Save & activate → returns to `/app` with the new goal in effect
   from the next tick.

### Flow I — Settings + MCP install

1. User on `/app` opens the wallet dropdown → Settings.
2. Routed to `/app/settings`.
3. Sections: Network, LLM, Cadence, API keys, MCP install,
   Disconnect.
4. MCP install section has a tabbed install snippet (one tab per
   host: Claude Code, Claude Desktop, Cursor, Windsurf, VS Code
   Copilot, Zed, Cline, Goose, OpenCode, Codex), each with a copyable
   command + post-install instructions.

### Flow J — Developer discovery

1. Developer arrives at `/` from a tweet about the SDK.
2. Scrolls past the consumer hero to the DeveloperCTA section.
3. Reads the 3-line code example.
4. Clicks "Read the docs".
5. Routed to `/docs` overview.
6. Clicks Quickstart in the left nav.
7. Reads / copies install command + first agent example.
8. Returns to `/docs` to read SDK reference.

### Flow K — MCP install from Claude Desktop

1. User (Claude Desktop power-user) reads the README's MCP section.
2. Adds Concierge MCP to Claude Desktop's config.
3. Restarts Claude.
4. Types "Concierge, what's my portfolio?" into Claude.
5. Claude calls the MCP server.
6. The MCP server returns a structured response plus a `ui://` HTML
   resource.
7. Claude Desktop renders the HTML resource inline (this is the
   Concierge portfolio card, designed by you, rendered inside Claude
   Desktop's chat).
8. User clicks "Approve" inside Claude Desktop's chat.
9. MCP Elicitation pops a structured confirmation form (max-slippage
   slider, justification text, confirm checkbox).
10. User confirms.
11. The same session key (Concierge-managed) signs.
12. The same on-chain tx confirms.
13. User sees confirmation card inline in Claude Desktop.

---

## §7 — Landing page (`/`)

The landing page exists to convert a 5-second skim into a click on
"Try on Sepolia" (consumer) or "Read the docs" (developer). It is the
flagship surface. Every section below is required.

### §7.1 — `<Hero>`

**Purpose.** State the wedge in one sentence and prove it with a live
demo.

**Content.**

- A single-sentence headline expressing what Concierge is. Locked
  positioning: "Autonomous AI agent for Mantle DeFi." The exact wording
  is yours.
- A supporting line — the one-sentence explanation of how it works.
- A primary CTA: "Try on Sepolia" (routes to `/app/onboarding/connect`).
- A secondary CTA: "Read the docs" (routes to `/docs/quickstart`).
- An embedded live-demo region showing a real tick streaming, sourced
  from a live Sepolia agent that ticks every 60s.

**Behavior.**

- The live demo runs on loop. A new tick streams in, runs through
  states, completes, then a fresh one starts.
- The status pill animates between states (`pending → planning →
  simulating → proposing → executing → confirmed → attested`).
- The reasoning text streams character-by-character.
- On hover (or focus) inside the demo, the animation pauses to let
  the user read.

**States.**

- `loading` — skeleton while the live demo data first fetches.
- `live` — the demo is running.
- `interaction-pause` — user is hovering or has focus inside.

**Accessibility.**

- `prefers-reduced-motion: reduce` → render a single still frame of a
  confirmed tick instead of the animated loop.
- The status pill announces state changes via an ARIA live region.

**Mobile.** Demo region collapses below the headline. CTAs stack
vertically.

### §7.2 — `<HowItWorks>`

**Purpose.** Make the loop legible in three steps.

**Content.** Three numbered steps:

1. "Set a goal in plain English."
2. "Your agent ticks 24/7."
3. "Verify every move on-chain."

Each step is a card with: step number, headline, one-line
description, optional icon, optional mini-animation that illustrates
that specific step (e.g., a text input filling for step 1; a tick
card streaming for step 2; a tx-hash + attestation pair for step 3).

**States.**

- `idle` — static.
- `inViewport` — mini-animation plays once when the section scrolls
  into the viewport (intersection observer).

**Mobile.** Vertical stack; mini-animations replaced with static
illustrations.

### §7.3 — `<KlarnaComparison>`

**Purpose.** Cost-of-credit framing — show that Concierge's mechanism
is structurally cheaper than traditional consumer credit.

**Content.** A side-by-side comparison.

- Left side: "Klarna 23.99% APR" or equivalent reference rate. This
  number is fixed at write-time.
- Right side: "Concierge — your collateral earns the loan interest"
  with a *live* spread number that comes from the `/api/rates`
  endpoint (Aave Oracle + DefiLlama proxy).
- A copy line explaining the framing in one sentence.

**Behavior.** The live rate number is fetched on every render
(server-side or client-side; behavior is "always fresh, never
hardcoded"). When the spread is positive (yield > rate), the section
displays in a success-leaning treatment. When compressed (near zero),
neutral with an explanatory tooltip. When negative, warning.

**States.** `loading`, `loaded`, `spread-positive`,
`spread-compressed`, `spread-negative`.

### §7.4 — `<DeveloperCTA>`

**Purpose.** Pitch the SDK to Mantle devs.

**Content.**

- A short copy line: "Drop Concierge into your agent stack."
- A code block with the install command (`pnpm add @concierge/sdk`).
- A 3-line example showing an agent being spun up.
- A "Read the docs" CTA.

**Behavior.** The code block has a copy-to-clipboard button; on copy,
a brief success animation confirms.

### §7.5 — `<KlarnaComparison>` (the comparison is one section; this is its sibling)

(Numbering continues — this is a placeholder; see §7.3 for the
comparison spec.)

### §7.5 — `<TrustSignals>`

**Purpose.** Establish credibility.

**Content.**

- Mantle Mainnet contract addresses (ConciergeRegistry, ERC-8004
  Identity / Reputation Registry) linked to MantleScan.
- GitHub repo link with live star count (fetched from GitHub's
  public API at render time).
- "Open-source MIT" badge.
- A "Composes 7 Mantle protocols" mini-grid: Aave V3, Merchant Moe,
  Agni, FusionX, Ethena, Ondo, mETH, Li.Fi, ERC-8004. Each logo links
  to that protocol's page.

**Behavior.** Addresses are copy-on-click. Logos are external links.

### §7.6 — `<Footer>` (full variant — see §10 for full intent)

The landing-page footer is the `full` variant: Product nav, Resources
(GitHub, X, Discord), Legal, the MCP install snippet, copyright + MIT
note.

### §7.7 — Landing-level interactions

- Smooth scroll between sections (respects `prefers-reduced-motion`).
- Header is sticky after scroll, condensed (compact logo + minimal
  nav + CTA).
- 404 page is branded; it does not look like Next.js's default.
- The hero's live demo is the only animated region above the fold;
  everything below the fold is static until scrolled into view.

---

## §8 — Web app (`/app/*`)

The product. Where users interact with Concierge once they've
onboarded.

### §8.1 — `/app` (dashboard)

The first authed landing. Sections from top to bottom:

1. **Greeting line.** "Good evening, alice.eth" or equivalent.
2. **Agent identity card.** The user's ERC-8004 agent NFT visual (its
   `tokenURI`), agent ID, creation date, reputation summary (count +
   average value).
3. **Live tick stream.** The most recent N tick cards (default 5),
   newest first. New cards slide in at the top as the server emits
   tick events via SSE.
4. **Portfolio snapshot.** Current positions across all 7 protocols,
   total USD, 24h delta.
5. **Active goal card.** Current goal text, activation status,
   autopilot toggles.
6. **Emergency Stop** (always visible in header on desktop; floating
   action button bottom-right on mobile).

### §8.2 — `/app/onboarding/*` (six steps)

See §6 Flow A. Each step is its own route with a step indicator in
the minimal header. Each step has a single primary action; back
navigation is allowed except at `/connect`.

### §8.3 — `/app/goal`

Edit active goal. Same layout as `/app/onboarding/goal` but
pre-populated. Adds spending-caps section + a Pause/Resume agent
toggle.

### §8.4 — `/app/ticks`

Full tick history. Paginated list (50 per page). Filter controls at
top. Each row is a tick card in compact-summary state.

### §8.5 — `/app/ticks/:tickId`

Single tick detail. Sections, top to bottom:

1. **Full reasoning text.** The complete LLM plan output (not just
   the streamed snippet from the dashboard).
2. **Simulation output.** Dry-run result, risk flags, expected
   outcome.
3. **Decision record.** Who approved (user vs autopilot) +
   timestamp.
4. **Execution record.** Tx hash + MantleScan link + gas used +
   final outcome.
5. **Attestation record.** ERC-8004 feedback hash + link to view it
   on the reputation registry.
6. **Replay button.** Re-runs the tick in dev mode with no on-chain
   side effects.

### §8.6 — `/app/portfolio`

Position detail across providers. See §6 Flow G.

### §8.7 — `/app/agent`

Authed view of the user's own agent reputation. Sections:

1. **Agent NFT visual.** `tokenURI` rendered.
2. **Agent ID + owner wallet.**
3. **Reputation summary.** Count, average value, decimals.
4. **Reputation history visualization.** Chart of attested ticks
   over time with positive/negative values.
5. **Share link.** Copy `/agent/:id` to clipboard.

### §8.8 — `/app/settings`

Sections:

1. **Network selector.** Mainnet ↔ Sepolia.
2. **LLM model overrides.** Per phase (plan, simulate, decide).
3. **Tick cadence override.** Default 60s.
4. **API keys.** For SDK and MCP server.
5. **MCP install.** Tabbed install snippets for the 10 supported
   MCP hosts.
6. **Disconnect / delete account.**

### §8.9 — `/agent/:id` (public reputation viewer)

Same content as `/app/agent` but unauthenticated, read-only, no
controls, no "Share" button (already shared). Header is the `landing`
variant.

---

## §9 — Docs site (`/docs/*`)

The docs exist to convert a Mantle developer into someone who `npm
install`s Concierge into their own agent and ships it.

### §9.1 — Layout

Three-column on desktop: left navigation, center content, right
on-this-page outline. Two-column on tablet (nav becomes a drawer).
Single column on mobile (nav becomes a hamburger drawer; outline is
hidden).

### §9.2 — Pages

| Route | Purpose | Anchors |
|---|---|---|
| `/docs` | Overview + table of contents. | Section list. |
| `/docs/quickstart` | "Clone to running agent in 10 minutes." | Prereq, install, first goal, first tick, what next. |
| `/docs/sdk` | `@concierge/sdk` API reference. | `createConcierge`, `tick`, `propose`, `execute`, `record`, types. |
| `/docs/providers` | Per-protocol reference. | One section per protocol (7 total). |
| `/docs/runtime` | Agent runtime concepts. | Tick loop, session keys, attestation, error model. |
| `/docs/skill` | RealClaw skill packaging. | Frontmatter spec, install snippet per host. |
| `/docs/mcp` | MCP server setup. | One section per host (10 total). |
| `/docs/recipes` | Copy-paste recipes. | Yield optimizer, depeg-resistant treasury, autopay. |
| `/docs/architecture` | System diagram + ADRs. | Surfaces, packages, data flow. |
| `/docs/contributing` | Open-source contributor guide. | Setup, branch, PR, review. |

### §9.3 — Page conventions

- Every page has a title (largest), then an optional one-paragraph
  intro, then sections.
- Every code block has a language label + copy-to-clipboard button.
- API reference uses a consistent table shape (parameter name, type,
  required/optional, description, default).
- Cross-links between pages are common; they look distinct from
  external links.
- Every page has "Edit on GitHub" and "Last updated" footers + prev /
  next navigation.

---

## §10 — Component catalog

Below is the full set of components across all surfaces, grouped by
where they primarily live. Every component lists: purpose, content,
states, behavior, accessibility, responsive.

For a quick scan: there are **40+ components**. The five highest-stakes
ones are `<TickCard>`, `<StatusPill>`, `<ReasoningStream>`,
`<ActionApprovalCard>`, and `<EmergencyStop>` — these are the visual
core of the product.

### §10.1 — App: `<TickCard>` (THE central UI primitive)

**Purpose.** Render a single tick's lifecycle in real time. This is
the demo wow factor.

**Content.**

- **Header:** status pill, tick ID, timestamp, agent name.
- **Body:** streamed reasoning text, nested simulation card (when
  present), nested action approval card (when proposing), nested tx
  confirmation card (when executing or confirmed), attestation
  summary (when attested).
- **Footer:** collapse/expand toggle, "View full detail" link to
  `/app/ticks/:tickId`.

**States.** Each state must be visually distinct.

| State | What's shown |
|---|---|
| `pending` | "Queued for next tick window." Compact. |
| `planning` | Streaming reasoning text. Status pill pulses. |
| `simulating` | Simulation card appears below reasoning with dry-run output. |
| `proposing` | Action approval card appears below simulation with Approve / Reject / Edit controls. |
| `awaiting-approval` | Same as proposing + a countdown timer ("Auto-rejects in 4m 23s") — manual mode only. |
| `auto-approved` | Brief confirmation animation, then transitions to executing. |
| `executing` | Tx submission indicator + pending tx hash. |
| `confirmed` | Tx hash + block number + gas + MantleScan link. |
| `attesting` | "Writing ERC-8004 attestation…" |
| `attested` | Final state. Collapsible compact summary. |
| `failed-simulation` | Constraint violation reason. |
| `failed-execution` | Revert reason + retry button. |
| `rejected-by-user` | "Rejected by user at 14:23." Muted. |

**Behavior.**

- Reasoning text streams character-by-character via SSE.
- Status pill transitions are pushed via SSE; the client updates
  immediately.
- Mid-card content (simulation, action approval, tx confirmation,
  attestation) renders progressively as data arrives.
- New tick cards slide in at the top of the stream; older ones
  collapse to compact form after the new card appears.

**Accessibility.**

- Status changes announce via ARIA live region (`role="status"`).
- All interactive controls (Approve, Reject, Edit, Expand) are
  keyboard-accessible (Tab + Enter/Space).
- Reasoning text region is `aria-live="polite"` so screen readers
  narrate the stream without interrupting.
- `prefers-reduced-motion` → status changes are instant, no transition
  animations.

**Responsive.**

- Mobile: cards stack vertically full-width. Action buttons stack
  vertically below the body. Expand/collapse remains tap-friendly.
- Desktop: cards can render side-by-side if multiple are streaming
  simultaneously (rare; not the common path).

### §10.2 — App: `<StatusPill>`

**Purpose.** Reusable pill showing tick state.

**Content.** Color + label per state (per the table in §10.1).

**Behavior.** Tween between states; respects `prefers-reduced-motion`.

**Size variants.** Small (inline in dense lists), medium (card
header), large (page title).

### §10.3 — App: `<ReasoningStream>`

**Purpose.** Stream the LLM's reasoning output character-by-character.

**Behavior.**

- Cursor animation while streaming.
- Pause/resume control for the user.
- Markdown rendering (bold, lists, code) on completed segments.
- Auto-scrolls to keep the most recent characters in view unless the
  user has scrolled up manually (then it pauses auto-scroll and shows
  a "jump to bottom" affordance).

**Accessibility.** `aria-live="polite"`; the cursor animation is
purely visual.

### §10.4 — App: `<SimulationCard>` (nested inside `<TickCard>`)

**Purpose.** Render dry-run output of the simulated action.

**Content.**

- Tx preview (target contract + selector + decoded args).
- Expected USD delta.
- Health-factor projection (Aave only).
- Risk flags (any constraint violations or warnings).
- A "before vs after" visual diff for each affected position.
- A "Why?" expandable section listing the constraint checks (LTV
  floor, slippage tolerance, etc.).

### §10.5 — App: `<ActionApprovalCard>` (nested inside `<TickCard>` during `proposing`)

**Purpose.** Let the user approve, reject, or edit the proposed
action.

**Content.**

- Action description (1 line, plain English: "Supply 100 USDC to Aave
  V3").
- Approve / Reject / Edit buttons.
- Approval countdown (manual mode only).

**Behavior.**

- Edit opens a modal with constrained parameter tweaks (e.g., supply
  amount, max slippage). On save, the agent re-simulates and
  re-proposes.
- Approve and Reject both close the card body and move it to the
  appropriate state.

### §10.6 — App: `<TxConfirmationCard>` (nested inside `<TickCard>` during `executing`/`confirmed`)

**Purpose.** Show the on-chain transaction's status.

**Content.**

- Tx hash (truncated, copyable, links to MantleScan).
- Block number, gas used, success/revert indicator.
- "Replay" button — re-runs the tick as a dry-run only.

### §10.7 — App: `<AttestationCard>` (final state)

**Purpose.** Show the ERC-8004 attestation that finalized the tick.

**Content.**

- Feedback hash (links to the reputation registry on MantleScan).
- IPFS content link (`ipfs://<cid>`).
- Value contribution ("+0.05 → agent reputation now +1.74").

### §10.8 — App: `<GoalCard>`

**Purpose.** Display the active goal at a glance.

**Content.**

- Goal text (the user's plain-English goal).
- Activation timestamp.
- Runtime indicator ("Active for 14 days").
- Autopilot category toggles (read-only view; tap to edit goes to
  `/app/goal`).
- Spending-caps display.
- Pause/Resume toggle.

### §10.9 — App: `<GoalInput>`

**Purpose.** Capture the user's plain-English goal and extract
structured parameters.

**Content.**

- Large text area.
- Example goals carousel below (clickable, fills the input).
- LLM-extracted parameter chips render below the text area as the
  user types (debounced).
- Chips are editable: tapping "70% LTV" opens a tiny inline editor.

### §10.10 — App: `<PortfolioPositionRow>`

**Purpose.** One row in a position list.

**Content.** Provider logo + asset symbol, amount, USD value, APR
(signed: positive for earning, negative for paying), optional
health-factor contribution (Aave only).

**Behavior.** Click expands to show full position detail inline (or
routes to a detail view on mobile).

### §10.11 — App: `<HealthFactorGauge>`

**Purpose.** Visual indicator of aggregate Aave health factor.

**Content.** Large radial gauge. Tooltip on hover explains HF mechanics
(below 1.0 = liquidatable).

**Behavior.** Live-updates on tick state changes. Color zones change
based on HF value (the exact colors are yours, but a typical pattern
is danger / warning / safe).

### §10.12 — App: `<ReputationChart>`

**Purpose.** Time series visualization of attested ticks.

**Content.**

- X-axis: time (last 30 days default, zoomable).
- Y-axis: cumulative reputation value.
- Each tick = a point, color-coded by value sign.

**Behavior.** Click a point → opens the specific tick detail.

### §10.13 — App: `<EmergencyStop>`

**Purpose.** The persistent kill switch.

**Content + behavior.**

- Always visible. Desktop: button in the app header. Mobile: floating
  action button bottom-right.
- Click opens a confirmation modal: "Stop all autopilot — existing
  positions remain."
- On confirm: revokes session keys, deactivates autopilot, halts
  cron.
- After stop: a persistent banner appears across the top of every
  `/app/*` route with a "Resume" button.

**Visual states.** `active` (button visible) / `stopped` (banner +
Resume button visible everywhere).

### §10.14 — App: `<AgentNFTCard>`

**Purpose.** Visualize the agent identity NFT.

**Content.**

- `tokenURI` rendered (the NFT image + metadata).
- Owner wallet address (shortened, copyable).
- Agent ID.
- Reputation badge (count + average).
- Share-link button.

### §10.15 — App: `<MCPInstallSnippet>`

**Purpose.** Code-block for installing the MCP server.

**Content.**

- Tabs: Claude Code / Claude Desktop / Cursor / Windsurf / VS Code
  Copilot / Zed / Cline / Goose / OpenCode / Codex / Custom.
- Each tab: the install command + post-install instructions for that
  host.
- Copy-to-clipboard button on the command.

### §10.16 — App: `<EmptyState>`

**Purpose.** Replace a normally-populated UI when nothing is yet
present (no active goal, no ticks).

**Content.** Illustration + one-line copy + primary CTA back to
onboarding or goal-set.

### §10.17 — App: `<ToastNotification>`

**Purpose.** Transient confirmations.

**Variants.** Success, info, warning, error.

**Behavior.**

- Auto-dismiss after 5s; hover pauses dismiss.
- Bottom-right corner; stacks newest-on-top.
- Screen-reader announcement via ARIA live region.

### §10.18 — App: `<Modal>`

**Purpose.** Confirmation and edit dialogs.

**Behavior.**

- Backdrop fade respects `prefers-reduced-motion`.
- Focus trap: focus stays within the modal; returns to the trigger on
  close.
- ESC and click-outside both close (with optional confirm-on-close
  for destructive flows like Emergency Stop).

### §10.19 — Landing: `<Hero>`

(Fully specified in §7.1.)

### §10.20 — Landing: `<HowItWorks>`

(Fully specified in §7.2.)

### §10.21 — Landing: `<KlarnaComparison>`

(Fully specified in §7.3.)

### §10.22 — Landing: `<DeveloperCTA>`

(Fully specified in §7.4.)

### §10.23 — Landing: `<TrustSignals>`

(Fully specified in §7.5.)

### §10.24 — Docs: `<DocsNav>`

**Purpose.** Left sidebar with hierarchical navigation.

**Content + behavior.**

- Collapsible sections.
- Active page highlighted.
- Search input at top.
- Mobile: drawer (hamburger toggle).

### §10.25 — Docs: `<DocsSearch>`

**Purpose.** Full-text search across docs pages.

**Behavior.**

- Keyboard shortcut to focus (Cmd / Ctrl + K).
- Suggestions list with title + breadcrumb path.
- Match highlights in result snippets.

### §10.26 — Docs: `<DocsCodeBlock>`

**Purpose.** Syntax-highlighted code with a copy button.

**Content.** Language label, optional filename header, optional line
numbers (default off), optional diff highlighting for migration
guides.

### §10.27 — Docs: `<DocsAPITable>`

**Purpose.** Function/parameter reference.

**Content.**

- Function signature header.
- Parameters table: name, type, required, description, default.
- Returns section.
- Example code block.

### §10.28 — Docs: `<DocsCallout>`

**Purpose.** Inline emphasis box.

**Variants.** Info, tip, warning, danger, success.

**Content.** Optional title + icon. Renders nested markdown.

### §10.29 — Docs: `<DocsLiveExample>`

**Purpose.** Embedded runnable example.

**Content.** Code on one side, live output on the other. "Open in
CodeSandbox" or "Open in Replit" link. Fallback to static output if
iframe is blocked.

### §10.30 — Docs: `<DocsFooter>`

**Content.** Edit-on-GitHub link, last-updated date, prev/next page
navigation.

### §10.31 — Cross-surface: `<Logo>`

**Variants.** Icon-only / icon + wordmark / wordmark-only. Full-color
/ monochrome dark / monochrome light. Links to `/` by default.

### §10.32 — Cross-surface: `<NetworkBadge>`

**Purpose.** Sticky network indicator.

**Content + states.** "Mantle Mainnet" / "Mantle Sepolia (Demo)" /
"Disconnected" — each color-coded.

**Behavior.** Click opens the network switcher modal.

### §10.33 — Cross-surface: `<WalletConnectButton>`

**States.**

- Disconnected: "Connect" CTA.
- Connected: address (truncated) + ENS / avatar + dropdown to
  disconnect.
- Connected with smart account: an additional smart-account indicator
  next to the EOA.

### §10.34 — Cross-surface: `<MantleScanLink>`

**Purpose.** Display an address or tx hash with a link to MantleScan.

**Behavior.**

- Truncated display (`0x458F…1422`).
- External-link icon.
- Click-to-copy on single click; click-and-hold follows the link.

### §10.35 — Cross-surface: `<SkeletonLoader>`

**Purpose.** Loading placeholder. Variants match the shape of the
content being loaded.

**Behavior.** Respects `prefers-reduced-motion` (no shimmer).

### §10.36 — Cross-surface: `<ErrorBoundary>`

**Purpose.** Catch React errors; render a friendly fallback.

**Content.** Reload button + GitHub issue link with auto-populated
stack trace.

### §10.37 — Header (4 variants)

Variants and contents:

- **`landing`** — Logo (left) · primary nav (center) · "Try on
  Sepolia" CTA (right). Used on `/`, `/agent/:id`, `/docs/*`.
- **`app`** — Logo (left) · network badge · agent identity card link ·
  Emergency Stop · wallet/account dropdown (right). Used on `/app/*`.
- **`minimal`** — Logo (left) · step indicator (center) ·
  exit-onboarding link (right). Used on `/app/onboarding/*`.
- **`docs`** — Logo (left) · search input + Cmd/Ctrl + K shortcut ·
  nav links (right). Used on `/docs/*`.

Heights are locked at 64px desktop / 56px mobile.

### §10.38 — Footer (3 variants)

- **`full`** — Sections: Product (links to /app, /docs, /agent),
  Resources (GitHub, X, Discord), Legal (License, Terms-stub) · MCP
  install snippet · copyright + MIT note. Used on `/`.
- **`minimal`** — Single line: "Concierge — built for Mantle Turing
  Test 2026 · MIT License · GitHub." Used on `/docs/*` and
  `/agent/:id`.
- **`none`** — No footer. Used on `/app/*` (Emergency Stop takes the
  persistent role).

### §10.39 — MCP UI Resources (embedded in Claude Desktop and other MCP hosts)

Concierge's MCP server returns structured responses with `ui://` HTML
resources. When a host (Claude Desktop, ChatGPT, Goose, VS Code
Insiders) supports MCP Apps (SEP-1865), it renders these resources
inline in the chat as sandboxed iframes.

These are not "regular" routes — they are tiny self-contained HTML
documents that render a single tool's output. The set of resources
mirrors a subset of the in-app components:

- `<MCPPortfolioCard>` — rendered when a tool returns portfolio
  state.
- `<MCPProposalCard>` — rendered when a tool returns a proposed
  action (Approve / Reject controls work via MCP Elicitation forms).
- `<MCPTickCard>` — rendered when a tool returns a tick's lifecycle
  state.
- `<MCPReputationCard>` — rendered when a tool returns an agent's
  reputation summary.

**Constraint.** Each resource must be a self-contained HTML document
≤ 100KB, no network requests at render time (all data is in the
initial render), no external font / JS / CSS, no localStorage /
sessionStorage. Designed for the iframe's sandbox.

**Visual continuity.** These cards must look like they came from the
same product as the web app — but the web app's CSS / tokens are
*not* available inside the iframe. You'll need to inline a minimal
token set into each resource. The set is small (the visual atoms used
by the four cards above) and can be a hand-written CSS block.

### §10.40 — Elicitation forms (MCP Elicitation, `mode: 'form'`)

When a Concierge tool requires user confirmation (executing a tx,
revoking a session key), the MCP server returns an Elicitation
request and the host renders a structured form. The form's fields are
described in JSON; the host renders them with its own form chrome.

You do not design the form's visual chrome (the host owns that). You
do design the *field copy*: labels, descriptions, default values,
warning text. Each Elicitation form is associated with one Concierge
action; the fields are typically (max-slippage, justification,
confirm checkbox).

---

## §11 — Accessibility (non-negotiable contract)

- **Keyboard-navigable everywhere.** Every interactive surface is
  reachable by Tab. Order matches visual flow. Skip-to-content link
  on every page.
- **Visible focus rings always.** Never use `outline: none` without a
  replacement focus indicator.
- **Screen-reader-friendly.** Status changes use ARIA live regions
  (`role="status"`, `aria-live="polite"`). Charts have text-form
  alternatives. Images have meaningful alt text or `role="presentation"`
  when decorative.
- **Color contrast WCAG AA minimum.** Body text ≥ 4.5:1, large text
  ≥ 3:1, UI components and graphical objects ≥ 3:1. Use a contrast
  checker on every color pair in your tokens.
- **`prefers-reduced-motion` respected.** No motion when set; final
  states render directly. This includes the hero's live demo (still
  frame fallback), tick card transitions (instant state changes), and
  all docs animations.
- **Tap targets ≥ 44 × 44 px** on mobile.
- **Text is resizable** via the browser zoom and font-size controls;
  layouts must not break at 200% zoom.

---

## §12 — Responsive (non-negotiable contract)

- **Mobile-first.** Every flow works on a 375 px viewport.
- **Breakpoint set is yours to pick.** A typical small / medium /
  large / xlarge cascade is fine, but the values are yours.
- **Mobile and desktop are not the same product visually.** Mobile
  prefers: vertical stacks, drawers for navigation, bottom-aligned
  primary actions, floating Emergency Stop. Desktop prefers:
  horizontal grids, persistent left nav, top-aligned actions, header
  Emergency Stop.
- **Dark mode is primary, light mode is supported.** Concierge's
  brand is designed for dark; both ship from day one. The dark/light
  switch lives somewhere reachable but not prominent (settings or a
  small toggle in the header).

---

## §13 — Data shapes that drive each component

This section ties components to the data they consume. Engineering
owns the shapes; the designer needs to understand what fields are
available to design against.

### §13.1 — `Tick`

Fields:

- `id` — string
- `agentId` — bigint (rendered as decimal string)
- `chainId` — number (5000 for Mainnet, 5003 for Sepolia)
- `status` — one of the lifecycle states in §10.1's table
- `createdAt` / `updatedAt` — ISO timestamp
- `reasoning` — long-form streamed text (markdown)
- `simulation` — `{ expectedUsdDelta, healthFactorAfter, riskFlags[] }`
- `proposal` — `{ action, description, params }`
- `execution` — `{ txHash, blockNumber, gasUsed, status }`
- `attestation` — `{ feedbackHash, ipfsCid, value, decimals }`

### §13.2 — `Position`

- `provider` — one of seven (Aave V3, Merchant Moe, Agni, FusionX,
  Ethena, Ondo, mETH, Li.Fi)
- `asset` — symbol + address
- `amount` — bigint (rendered in the asset's decimals)
- `usdValue` — number
- `apr` — number (signed)
- `healthFactorContribution` — number (Aave only, optional)

### §13.3 — `Reputation`

- `agentId` — bigint
- `count` — number (total attested ticks)
- `averageValue` — number (signed; can be negative if the agent did
  poorly)
- `decimals` — number (from ERC-8004)
- `history` — array of `{ tickId, timestamp, value }`

### §13.4 — `AgentNFT`

- `tokenId` — bigint
- `tokenURI` — string (resolves to JSON with `name`, `image`,
  `description`, `attributes`)
- `owner` — address

### §13.5 — `Goal`

- `text` — string (plain English)
- `parameters` — extracted chips, each `{ key, value, type }`
- `policies` — per-category `{ aave, dex, bridge, yield, restaking }`
  each `'autopilot' | 'manual'`
- `spendingCaps` — `{ perDay, perTx, perCategory }`
- `pausedAt` — nullable timestamp

### §13.6 — `Rates` (for `<KlarnaComparison>`)

- `aaveSusdeSupplyApr` — number (annualized)
- `aaveUsdcBorrowApr` — number
- `klarnaApr` — fixed constant
- `spread` — `aaveSusdeSupplyApr - aaveUsdcBorrowApr`
- `fetchedAt` — timestamp

### §13.7 — `Network`

- `chainId` — 5000 or 5003
- `name` — "Mantle Mainnet" or "Mantle Sepolia (Demo)"
- `connected` — boolean

---

## §14 — What this brief deliberately does NOT prescribe

These choices are yours. The brief calls out the categories so you
have a checklist; the values are not in this document.

- **Color palette.** Background, surface, border, text, accent,
  semantic (success, warning, danger, info), per-state status pill
  colors, dark and light variants.
- **Typography.** Display family, body family, monospace family,
  weight scale, size scale, line-height scale.
- **Spacing scale.** Base unit (4 / 8), step ratio, max value.
- **Border-radius scale.** Including the project-specific decision
  about card radius.
- **Motion language.** Easing curves, duration tiers, animation
  primitives (slide, fade, scale, etc.), the rule for when to use
  each.
- **Iconography.** Set, weight, optical size, custom icons for the
  status pill states.
- **Illustration style.** Hero illustration, empty-state
  illustrations, How-It-Works step illustrations.
- **Elevation hierarchy.** When to use a shadow, what shadow, on what
  surfaces.
- **Density.** How tight or loose the spacing is, per surface.
- **Logo.** Wordmark, icon, lockup.
- **Anchor product.** Whether you pick Linear / Stripe / Vercel /
  Granola / v0.dev / something entirely your own as a quality
  reference — yours.

---

## §15 — Functional anti-patterns (not visual prescriptions)

These are functional rules, not visual ones. They apply regardless of
your visual choices.

- **No marketing buzzword copy.** "Set a goal" not "Unleash
  AI-powered autonomous DeFi optimization."
- **No emoji in product chrome.** OK in copy where they carry
  information.
- **No truncation that hides information without an affordance to
  expand.** Addresses are truncated with copy-on-click. Long text gets
  an explicit "Read more" affordance.
- **No silent loading.** Every loading state is communicated —
  skeleton, spinner, or text.
- **No silent failures.** Every error state has copy that explains
  what happened and what the user can do next. Generic "Oops!" is
  forbidden.
- **No hardcoded numbers that look live.** If a number is fetched, it
  must actually be fetched and have a loading state. The
  `<KlarnaComparison>` live rate is the canonical example.
- **No demo-only routes.** Every URL a judge sees is a real
  production route.
- **No model-driven layouts.** Each tool result renders a specific
  card; the LLM does not pick layouts at runtime.

---

## §16 — References (source material)

The brief above is the canonical designer-facing summary. For
engineering-level depth on any topic, the underlying source documents
are:

- `docs/PRD.md` — product requirements, the four-surface model,
  judge demo walkthrough, locked technical decisions, out-of-scope
  list.
- `docs/ux-spec.md` — route shape, structural locks, design-token
  contracts (categorical only — values are yours), header/footer
  variants, banned engineering-side patterns.
- `research/concierge/08-ux-component-intent.md` — the original
  component intent file; everything in §10 above derives from it.
- `research/concierge/01-wedge-locked.md` — the product wedge in full,
  including the "user as principal, agent as steward" framing that
  drives the brand voice in §3.
- `research/concierge/CONTEXT.md` — entry point into the research
  folder.
- `research/concierge/04-agent-runtime.md` — the tick loop and
  streaming contracts that drive `<TickCard>`'s state machine.
- `research/concierge/06-realclaw-skill-pkg.md` — skill packaging
  format that drives the `<MCPInstallSnippet>` tab set.
- `research/concierge/07-mcp-server-pattern.md` — MCP transport that
  drives the embedded HTML resources in §10.39.
- `docs/architecture.md` — full ADR list (19 ADRs) covering every
  locked engineering decision. Read if you want to understand *why* a
  thing is the way it is.

---

## §17 — Deliverables checklist

When you ship the design, the following are required for engineering
to consume:

- `@concierge/ui/tokens` — published design token module covering
  every category in §14.
- `@concierge/ui/fonts` — font files (or CDN links) packaged.
- A Figma file (or your tool of choice) showing every component in
  §10 in every state, plus every page in §7–§9 in every breakpoint
  (mobile 375, tablet, desktop, wide).
- A dark + light variant for every screen.
- A `prefers-reduced-motion` variant for every page that animates.
- Logo files (SVG) in each variant per §10.31.
- Icons (SVG) for each status pill state + every other in-product
  icon usage.
- Illustrations (SVG) for the hero, empty states, and How-It-Works
  steps.
- A 404 page design.
- A handoff document describing motion primitives + their use rules
  (when fade, when slide, when scale).

---

## §18 — How to ask questions

When something in this brief is ambiguous or conflicts with another
source:

1. The brief itself wins for designer-facing scope.
2. The PRD wins for product-scope conflicts.
3. The ux-spec wins for route + structural conflicts.
4. `08-ux-component-intent.md` wins for component intent conflicts.
5. If still ambiguous: open a thread; engineering will respond.

Welcome to the project.
