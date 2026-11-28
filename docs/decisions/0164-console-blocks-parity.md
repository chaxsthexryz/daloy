# 0164. Console Blocks parity: one sidebar tree, no duplicate tab bars, editor first

## Status

Accepted

## Context

After R1 to R5 the console used the Console Blocks look, but several pages still differed from the clickable mock (`docs/design/console-blocks-preview.html`). The sidebar tree already linked Calendar, Rooms and slots, Details and branding, Knowledge, Apps and Team, and the same pages also had their own tab bars, so each place was shown twice. Automations repeated the Live, Runs today, Success, Needs you and Problems cards from Home. Opening an automation landed on its Overview status page instead of the editor. Name and password sat on a separate Account page. The owner asked for the console to match the mock one to one and chose, when asked:

- Apps and Support as their own sidebar items, as in the mock.
- Account merged into Settings.
- Build with AI with a few example chips, not the long categorised list.
- Opening an automation goes to the editor, with no Overview tab.

## Decision

- **Sidebar (`Nav.tsx`)**: Work has Home, Inbox, Bookings (Calendar, Rooms and slots) and Automations (All automations, Build with AI, Templates). Workspace has Apps, Business (Details and branding, Knowledge, Team), Settings and Support (`#/feedback`). `section()` maps `#/apps*`, `#/business?tab=apps` and the Outlook callback to Apps, `#/feedback` to Support, and `#/account` to Settings. The footer Account link opens Settings. Send feedback left the help menu, since Support is in the sidebar.
- **No duplicate tab bars**: Business, Bookings and New automation drop their tab bars. Each page's title is the sidebar item's name (Details and branding, Knowledge, Apps, Team, Calendar, Rooms and slots, Templates, Build with AI). Calendar and Rooms and slots link to each other from the page head, and Templates links to Build with AI and All automations. Embedded pages drop the headings and leads the page head now carries.
- **Automations**: the KPI band is gone; the counts stay on Home. The page is the quick-start strip, the filters and the table.
- **Editor first**: Open, a double click and Shift+Enter on a row, Home's running chips and the Apps usage list open `#/w/<id>`. Drafts still open their guided setup with Continue setup. The automation tabs are Steps and Activity, shown with Versions as one segmented control beside the editor's actions, as in the mock. The status page at `#/a/<id>` still exists for guided setup.
- **Account & Security**: one card at the top of Settings holds the name form and the password form. `#/account` opens Settings for workspace roles. Approvers and requesters, who have no Settings page, keep `#/account` with the same card.
- **Build with AI**: the four starter chips (Freelancer, Small shop, Salon, Virtual assistant) and More (Templates) sit under the box.
- **Settings fits one screen**: two columns as in the mock. The left holds Account & Security (name beside the sign-in email, the two password fields side by side) and Appearance & Language (theme and, for owners, workspace language as segmented choices). The right holds Notifications and Plan and usage. Advanced is a short row of links underneath. The head shows the person's name and role.
- **Diagram first**: the editor opens in Diagram view on a computer, as in the mock, and in List view on a phone. This replaces the List-first default from decision 0146.
- **Sign in**: Forgot your password? sits under the password box at the right, on every screen size.
- **No breadcrumb on automation pages**: the editor, guided setup, Activity and Versions drop the Automations / name breadcrumb, since the sidebar already shows where you are. Deeper pages that are not in the sidebar (a single run, Secrets, API tokens, AI model) keep theirs as the way back.
- **Publish toast**: publishing from the editor also shows a toast at the lower right, "<name> version <n> is live."
- **Guided setup and small fixes**: the guided setup page (`#/a/<id>`) shows its main card (as wide as its content) and steps panel side by side, with Back, Next and Save and finish later in one row and the sample test as one row per step, and the day buttons under Home's What ran are small round pills instead of stretched cells.

## Consequences

- Every page is reached from one place, the sidebar tree, and is named once.
- Old links (`#/business?tab=apps`, `#/resources`, `#/account`, `#/a/<id>`) still work.
- No API, database or migration change.
