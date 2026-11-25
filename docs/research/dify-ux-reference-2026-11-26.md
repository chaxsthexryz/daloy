# Dify Cloud UX & Architecture Reference (2026-11-26)

Read-only inspection of `https://dify.ai/` and logged-in `https://cloud.dify.ai/` (`version 1.19.0`, workspace `Dify's Workspace · sandbox`). Captured as a UX, navigation, onboarding, support, admin, and customer-app reference for `kymavo`.

---

## 1. Public Entry Flow (`dify.ai` to `cloud.dify.ai`)

1. **Marketing site (`https://dify.ai/`)**:
   - **Announcement banner**: Top promo bar with `Learn More` blog link.
   - **Top navigation bar**:
     - Left/center: `Dify` logo (`/`), dropdowns (`Products`, `Solutions`, `Company`), direct links (`Docs`, `Pricing` at `/pricing`).
     - Right CTAs: `Contact Sales` (sales inquiry form), `Log in` (`https://cloud.dify.ai/signin`), primary blue `Get Started` (`https://cloud.dify.ai/`), and `EN` language switcher.
   - **Hero**: Headline ("AI Agent Management Platform that Puts You in Control"), short value prop, and product video preview (primary CTAs stay anchored in the sticky top bar).
   - **Deployment tiers ("Deploy Dify Your Way")**:
     - `Dify Cloud` (Managed): `Learn more` (`/dify-cloud`) + `Get Started` (`https://cloud.dify.ai/`)
     - `Dify Enterprise` (Self-hosted): `Learn more` (`/dify-enterprise`) + `Contact Sales`
     - `Community Edition` (Open-Source): `View on GitHub`
   - **Interactive Showcase**: Tabbed `Workflow Studio` (`Workflow`, `Agent`, `Knowledge Pipeline`, `Plugins`, `Publish & Monitor`) with `Explore Workflow Studio` (`/workflows`) + bottom `Get Started` and `Contact Sales`.
   - **Footer**: `Docs`, `Blog`, `Events`, `Support` (GitHub Issues), `Roadmap`, `Talk to Us`, `Join Us`, `Brand Guidelines`, `Education`, `Partner`, legal/compliance policies.
2. **Auth Handoff**:
   - Clicking `Get Started` routes cleanly to `https://cloud.dify.ai/signin?redirect_url=%2F` (`Log in to Dify`: GitHub, Google, or Email + OTP verification code).

---

## 2. Logged-In Global Shell (`https://cloud.dify.ai/`)

### Persistent Left Sidebar
- **Top utilities**: Dify logo (`/`), `Search for anything` (`Ctrl+K` command palette), **Workspace Switcher** (`Dify's Workspace · SANDBOX`), and **Credits & Plan Bar** (`200 credits` linking to `/integrations/model-provider` + `UPGRADE` button).
- **Workspace Switcher popover**: Current workspace + plan badge (`SANDBOX`), `Workspace settings` (`?settings=billing`), `Invite members`, `Sort workspaces`, `Search`, and workspace list.
- **Main navigation (`Main menu`)**:
  1. `Home` (`/`)
  2. `Studio` (`/apps`)
  3. `Agents` (`beta` badge, `/agents`)
  4. `Knowledge` (`/datasets`)
  5. `Integrations` (`/integrations/model-provider`)
  6. `Marketplace` (`/marketplace`)
- **Bottom-left footer (clean separation of Account vs Support)**:
  - **Profile menu (`Dify` avatar -> `<owner-email>`)**:
    - `Account` (`/account`: Name edit, Email change, Delete Account)
    - `Preferences` (`?settings=preferences`)
    - `Appearance` (Theme switcher)
    - `Log out`
  - **Help menu (`?` button)**:
    - `Documentation`, `Roadmap`, `Learn Dify`, `Step-by-step Tour`, `Compliance`, `Contact Us`, `Upgrade`, `Discord`, `Creator Center`, `GitHub` (`161,849`), `About` (`version 1.19.0`).

---

## 3. Home, Onboarding, & Studio (`/`, `/apps`, `/agents`)

### Home (`/`)
- **Greeting banner**: `Welcome back, Dify` ("What if... this is where your next idea begins.")
- **Featured carousel (7 slides, `01` to `07`)**: Product announcements (`VIEW MORE`, pause/play).
- **Learn Dify (`Hide` toggle)**: 3 guided starter lessons (`Workflow: Text Summarizer`, `Chatflow: AI Chatbot`, `Knowledge: Chat with Your Documents`).
- **Templates Gallery directly on Home**: `View more` (`marketplace.dify.ai/templates`), 8 category pills (`All`, `Dify 101`, `Support & Service`, `Knowledge & Docs`, `Productivity & Ops`, `Marketing & Content`, `Sales & Outreach`, `Data & Analytics`), search input (`Search all templates...`), and cards badged by type (`WORKFLOW`, `CHATFLOW`, `AGENT`, `CHATBOT`, `COMPLETION`).
- **Floating Onboarding Checklist (`Get to know Dify`, `0/4`)**: Minimizable 4-step tour ("about 5 minutes") with `Take a look` actions and `Skip tour`:
  1. `Try a Learn Dify lesson`
  2. `Manage your apps in Studio`
  3. `Add your own data`
  4. `Explore integrations`

### Studio (`/apps`) & Agents Beta (`/agents`)
- **Note**: `/explore/apps` redirects to `/` (`Home`). Template browsing lives in `Home`, `Studio -> Create from Template`, and `Marketplace -> Templates` (`/templates`).
- **Studio top bar**: `Types` filter (`All`, `Workflow`, `Chatflow`, `Chatbot`, `Agent`, `Text Generator`), `Tags`, `Creators`, sort (`Last modified`), search (`Search Applications`), `Snippets` (`/snippets`), and `+ Create` (`Create from Blank`, `Create from Template`, `Import App` package/DSL).
- **Studio empty state (`Build your first App`)**: `Create from Template`, `Create from Blank`, `Or Import App`, plus the 3 `Learn Dify from Template` cards.
- **`Create from Blank` modal**: Pick app type (`Workflow`, `Chatflow`, plus expandable `Chatbot`, `Agent`, `Text Generator`), set `App Name & Icon` (emoji/icon picker) and `Description (Optional)`, `No ideas? Check out our templates` helper link, `Create (Ctrl+Enter)`, and a **live right-hand UI preview** of the selected app type.
- **Template Details modal (2 tabs)**:
  1. **`Orchestration Details` tab**: Read-only React Flow graph with sticky-note comments, zoom controls (`Zoom Out`, `%`, `Zoom In`), minimap, `+ Create from this sample app`, `Category`, and `Requirements` (e.g., `gpt-5.1`).
  2. **`Try it` tab (Customer-Facing App Preview)**: Lets users test a sample app before cloning (with a dismissible trial notice).
     - *Chatflow example (`File Translation`)*: App intro + pre-chat setup form (`Document to translate`, `Language`) + `Start Chat` + bottom chat input.
     - *Workflow example (`Workflow: Text Summarizer`)*: Input textarea + `Clear` + `Execute` -> structured output panel.
- **Agents Beta (`/agents`)**: Dedicated view with `Learn more about Agent`, `All / Published / Drafts` filter tabs, search, `Created by me`, sort, and `+ Create`.

---

## 4. Knowledge (`/datasets`)

- **Modes**: `Classic` (`/datasets`) vs `Agent Beta` (`/datasets?view=agent`: "Add your documents and agents can read them directly, no indexing to configure").
- **Top API controls**: `External Knowledge API` and `Service API` (`Enabled`, endpoint `https://api.dify.ai/v1`, API Key, API Reference).
- **Filters**: `Tags`, `Creators`, `Search`, `All Knowledge` checkbox, `+ Create`.
- **Creation entry points**:
  1. `Create a ready-to-use knowledge base` (`/datasets/create`: 3-step wizard: `Data Source` -> `Document Processing` -> `Execute & Finish`).
  2. `Build a custom knowledge base` (`/datasets/create-from-pipeline`: Knowledge Pipeline workflow).
  3. `Connect to an External Knowledge Base` (`/datasets/connect`).
- **Agent Beta empty options**: `Connect a source` (Notion, websites, etc.), `Upload files`, or `Start empty`.

---

## 5. Integrations (`/integrations/*`) & Marketplace (`/marketplace`)

Dify unifies AI models, tools, data sources, triggers, and webhooks under **Integrations**:
- **Top CTA**: `+ Install` (`Marketplace`, `GitHub`, `Local Package File`).
- **Left sub-navigation**:
  1. `Model Provider` (`/integrations/model-provider`): Shows `AI CREDITS: 0 / 200 used`, pre-installed providers on platform credits (`OpenAI`, `Anthropic`, `Gemini`, `Tongyi`) with optional `Add API Key`, `Show Models`, `Add Model`; BYOK providers (`xAI` showing `API key required`); `Default Models`; `Auto-update LATEST`; Marketplace install section below.
  2. `Tools` group: `Tool Plugin` (built-ins like `Audio`, `Code Interpreter`, `CurrentTime`, `WebScraper` + Marketplace), `MCP` (`Add MCP Server HTTP`), `Workflow as Tool`, `Swagger API as Tool`.
  3. `Data Source`: Notion, Google Drive, Firecrawl, GitHub, Confluence, SharePoint, OneDrive, S3, GCS.
  4. `Trigger`: Telegram, Gmail, Outlook, GitHub, Notion, Lark, LangBot.
  5. `Agent Strategy`.
  6. `Extension`: HTTP/Webhook integrations.
  7. `Custom Endpoint`: Centralized custom API endpoint list.
- **Governance footer**: `Debugging` and `Permissions` (`Who can install and manage?` / `Who can debug?` scoped to `Everyone`, `Admins`, or `No one`).
- **Marketplace**: `Plugins` tab (`/marketplace`: `Top 20 Models`, category filters, curated collections) and `Templates` tab (`/templates`).

---

## 6. Workspace Settings Modal (`?settings=<tab>`) & Customer App Customization

Dify keeps **Admin / Workspace Governance** inside a single tabbed Settings modal, separated clearly from user-level preferences:

### `WORKSPACE` Section (Owner / Admin)
1. **`Members`** (`?settings=members`): Member counter (`Member 1/1`), `Upgrade Now`, `Add`, and table (`NAME`, `LAST ACTIVE`, `Role`).
2. **`IP Policies`** (`?settings=ip-policies`): App IP allowlists (`Pro plan` gated).
3. **`Billing`** (`?settings=billing`): Explicit notice ("Only team owner and team admin can subscribe and view billing information"). Shows current tier (`Sandbox`), `Get Education Verified`, `Upgrade`, 7 clear quota meters (`Build Apps`, `Team Members`, `Documents Upload Quota`, `Knowledge Data Storage`, `Annotation Quota`, `Trigger Events`, `API Rate Limit` + `Resets in 4 days`), and `Billing and Subscriptions -> Manage`.
4. **`Customization`** (`?settings=custom`): Plan-gated white-label controls (`Remove Powered by Dify`, `Change Powered by Brand Image` SVG/PNG min 40x40px) paired with **live customer-facing WebApp previews**:
   - `Chatflow App` preview (`POWERED BY` badge, greeting bubble, chat input).
   - `Workflow App` preview (`RUN ONCE` / `RUN BATCH` tabs, `Execute`, `POWERED BY` badge).
5. **`Archived logs`** (`?settings=workflow-log-archives`): Monthly CSV exports of archived workflow run logs (upgrade-gated).

### `Preferences` Section (Per User) & `/account`
- **`Preferences`** (`?settings=preferences`): `Appearance` (`Follow system`), `Display Language`, `Time Zone` (`+08:00 Philippine Time`).
- **`Account`** (`/account`): Personal profile (`Name`, `Email`, `Delete Account`).

### Customer-Facing WebApp Separation (Observed via Previews & Create Flow)
- **Builder Canvas vs WebApp**: The builder uses React Flow (`Orchestrate`, `API Access`, `Logs & Annotations`, `Monitoring` on the left rail, `Auto-Saved · Unpublished`, top-right `Preview` / `Publish`), while customers only ever see a focused single-purpose **WebApp** (either a `Chatflow` conversation + pre-chat fields, or a `Workflow` `RUN ONCE` / `Execute` form).
- **Note**: Because the inspected workspace had `0` persisted apps and no data was created or deleted during read-only review, a live saved `/app/<id>/workflow` `Publish` dropdown (`WebApp link`, `Embed`, `Version history`) was not opened directly; those behaviors were observed via the `Create from Blank` preview, `Template Details -> Try it`, and `Customization` WebApp previews.

---

## 7. Actionable Takeaways for kymavo

### Adopt from Dify
1. **Clean Domain & Portal Separation**: Keep marketing, docs, pricing, legal, and support on the root domain (`yourdomain.com` on Cloudflare Pages), and put sign-in, onboarding, studio, and customer links on `app.yourdomain.com`.
2. **Non-Blocking Guided Onboarding Tour**: Right after sign-up (once F6 unlocks onboarding), take new owners through Brand/Business setup, then show a minimizable 4-step `Get started` checklist on the dashboard or Home page (with `Skip` / `Dismiss`) alongside 3 simple starter templates.
3. **"Try it" Customer Preview Inside Library & BrandKit**:
   - In `Library` (`#/new`) previews, alongside the read-only diagram (`Orchestration Details`), add or polish a `Try how customers see it` preview tab showing the resulting customer form / pay page / DM reply.
   - In `Business` / `Onboarding Step 1` (logo + brand colour customizer), render a **live customer preview** of a Form + GCash/QR Ph Pay Page right next to the colour/logo inputs (matching Dify's `Settings -> Customization` preview pattern).
4. **Dedicated `?` Support Menu**: Add a persistent `?` Help/Support popover in the console sidebar footer linking to `How it works / Docs`, `Support` (form on your static site), `Tour`, and `Contact / Upgrade plan` (leaving the profile menu strictly for `Account`, `Preferences`, `Appearance`, `Log out`).
5. **Clear Owner-Only Billing & Quota Meters**: Keep usage meters and plan upgrade instructions cleanly grouped under `Settings -> Plan and usage`, explicitly visible only to workspace owners/operators (and upgrade-request links pointing to Support/Contact).

### Keep kymavo Simpler Than Dify
- **Do not copy Dify's developer complexity** (`MCP`, `Swagger API`, `Agent Strategy`, `Snippets`, `Document Processing` pipelines, `External Knowledge API`). `kymavo` wins with PH SMBs because **Bookings**, **Resources**, **Receipts to review**, **Conversations**, and **simple Q&A Knowledge** are first-class operational tools out of the box.
- **Keep customer pages zero-login**: Unlike Dify WebApps aimed at knowledge workers, `kymavo` customer links (`/f/...`, `/pay/...`, Messenger/WhatsApp/SMS replies) should remain mobile-first, lightweight, and BrandKit-branded without requiring customer accounts.
