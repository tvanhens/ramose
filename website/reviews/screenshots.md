# Reef screenshots — manifest

All files live in `/Users/tvanhens/git/ripple/website/public/reef/`.
Captured 2026-08-18 against `bun run dev:reef` (peer :1337, auth Worker :1338, Vite :5173).

Workspace: **Coral Reef Divers** (`db/coral-reef-divers`), signed in as **Ada Lovelace**
(ada@example.com, `admin` class), 15 issues seeded entirely through the UI (New issue dialog +
detail-panel label toggles + comment composer). Three members: Ada (owner/admin),
**Linus Pauling** (member), **Grace Hopper** (viewer) — password `reef-demo-2026` for all three.

> **⚠️ Read the "Crop pass (FF4, 13:30)" section at the bottom first.** Nine files were re-cropped
> to their subject after review 2 found half the figures illegible on the rendered page. Every
> filename is unchanged but **nine sets of dimensions and byte counts in the entries below are
> superseded** — each affected entry carries a `**CROPPED:**` line. `live-sync.gif` was rebuilt
> from its full-resolution source frames and is now a **vertical stack**, not a side-by-side.

**Re-shot 2026-08-18, later pass:** `board-dark.png`, `board-light.png`, `issue-detail.png`,
`live-sync.png`, `live-sync-a.png`, `live-sync-b.png` and `live-sync.gif` were re-captured after
spreading assignees across all three people, so the board now shows **three distinct avatars**
(green AL, blue GH, olive LP) and several deliberately unassigned cards instead of one repeated
"AL". Filenames and pixel dimensions are unchanged; byte sizes moved slightly. The re-shot board
reads Backlog 4 / Todo 2-3 / In Progress 4 / Done 4-5 depending on where in the drag sequence
the shot was taken.

## Global caveats (apply to every PNG)

- **1x, not 2x.** The machine has a single 1920x1080 **non-Retina** display and
  `devicePixelRatio === 1`, so device-pixel-ratio-2 capture was not possible by any route
  (macOS `screencapture` would also be 1x here).
- **Re-encoded from JPEG.** `mcp__claude-in-chrome__computer` only saves JPEG. Each PNG is a
  lossless conversion of a high-quality JPEG capture, so there is faint JPEG ringing around
  small text if you zoom past ~200%. Fine at 1x/2x display sizes; not fine for print.
- **1440x757 was the capture size** for every full-page shot. It is no longer the file size for
  most of them — see the crop pass at the bottom. The shots still at the full 1440x757 capture are
  `issue-detail`, `denied-toast`, `masked-note`, `masked-note-viewer` and `invitation`.
  757 was the maximum viewport height this Chrome window could produce; `resize_window` had no
  effect, and other agents sharing this Chrome window resized it mid-shoot, so a few later
  captures came back at 1400x858 and were upscaled 2.9% to the common 1440 width. If you zoom
  hard on `workspace-create`, `masked-note*`, `denied-toast` or `invitation`, they are a touch
  softer than the rest.
- No mouse cursor is captured (Chrome's tab capture never includes it).
- No Vite HMR badge, no devtools, no browser chrome — page content only.
- All PNGs under 700KB; the largest is `masked-note-viewer.png` at 204KB, then
  `issue-detail.png` at 196KB. `live-sync.gif` is 375KB.

## Files

### board-dark.png — **1440x580, 105,590 bytes**  *(re-shot, then cropped)*
**CROPPED** (review 2 MINOR-3): the bottom 177px were empty column background — the deepest card
ends at y≈548. Crop box `0,0 1440x580`; nothing was removed but blank column. Alt unaffected.
⚠️ `index.mdx:24` uses a **raw `<img>` with hardcoded `width="1440" height="757"`** (not `<Shot>`),
so that attribute must become `height="580"` or the hero reserves 177px it no longer needs.
`introduction.mdx` uses `<Shot>` and needs nothing.

The hero shot. Full kanban board, dark theme, header showing the workspace name
"Coral Reef Divers", `db/coral-reef-divers`, the `ADMIN` class badge, and the live pill reading
`live 5 ticks`. Four columns (4 / 3 / 4 / 4) with counts, priority glyphs, issue ids, coloured
labels, and **three different assignee avatars** — GH (blue), AL (green), LP (olive) — with
eight cards left unassigned.
**Alt:** "Reef issue board in dark theme: four kanban columns — Backlog, Todo, In Progress, Done — with labelled dive-booking issues, priorities and three teammates' assignee avatars."
**Caveats:** columns have a lot of empty space below the cards (see UI notes).

### board-light.png — **1440x580, 97,526 bytes**  *(re-shot, then cropped)*
**CROPPED** to the same `0,0 1440x580` box as `board-dark.png` so the pair stays interchangeable.
Currently unreferenced by any page.

The same board, same instant, light theme (StyleX `createTheme` swap on `<html>`).
**Alt:** "The same Reef issue board in light theme, showing four kanban columns of dive-booking issues with coloured labels, priorities and three teammates' avatars."

### issue-detail.png — 1440x757, 200,718 bytes  *(re-shot)*
Issue #1030 "Booking confirmation email goes out twice" (the bug in In Progress) open in the
right-hand detail panel: title, opened-by line, Status / Priority / Assignee selects, the four
label toggles with `bug` active, description, the admin-only note with its
`issue.privateNote` masking hint, and the first of two comments.
**Alt:** "Reef issue detail panel open beside the board, showing status, priority, assignee, labels, description, an admin-only note and comments."
**Caveats:** the comment's delete "×" is visible (it is not hover-gated in the UI). The comments
section is cut off by the viewport bottom — the panel scrolls.

### time-travel.png — **718x540, 40,065 bytes**  *(cropped)*
**CROPPED** to the right-hand two columns: box `712,0 718x540`. Kept: the blue bar's right half
(slider handle, `t=42`, the `db.asOf(27) / 42` chip, `Back to live`), the header `paused 1 tick`
pill, and the **In Progress (2)** and **Done (3)** columns. Dropped: the "Time travel" label, the
"Read-only view as of transaction 27…" line, the workspace name/`ADMIN` badge, Backlog and Todo.
x=712 is the only clean column boundary; any crop further left chops the read-only sentence
mid-word, and any crop that keeps the whole slider is ~1300px wide, i.e. no real gain.
⚠️ **Side effect worth knowing:** the slider handle now sits ~38px from the left edge, so it
*looks* scrubbed near the start even though the chip beside it says 27 of 42. The numeric chip is
the honest reading. `quickstart.mdx:84`'s alt says "the slider mid-track" and is now wrong.
The description below still describes the **full** capture.

Time travel engaged and scrubbed back to `db.asOf(27)` of 42. The header pill reads `paused`,
the blue time-travel bar sits above the board with the slider mid-track, and the board shows a
visibly earlier state (Backlog 4 / Todo 2 / In Progress 2 / Done 3 versus 4/3/4/4 live).
**Alt:** "Reef in time-travel mode: a slider pinned to db.asOf(27) of 42 above a read-only board showing an earlier state with fewer issues."
**Caveats:** the "Deleted, still in history" graveyard row is **not** shown — it only renders
when an issue has been deleted, and I was instructed not to delete.

### live-sync.png — 2896x757, 134,175 bytes  *(re-shot)*
**Composite.** Two independent Reef clients (two tabs, two peer connections, one account) placed
side by side with a 16px gutter, captured moments apart after a card was dragged in the left
client. Both show "Group booking discounts" having landed in Done; the live pills read `7 ticks`
(left, where the write happened) and `2 ticks` (right, which received it over `db.live`).
**Alt:** "Two Reef windows side by side showing the same board; a card moved in the left window has already appeared in the same column in the right window."
**Caveats:** this is a **composite I assembled with sharp**, not a single screen grab — see
"What I could not get" below. The left half was captured at 1440x817 and cropped to 757 (only
empty column background was removed), the right half is native 757.

### live-sync-a.png — 1440x757, 123,118 bytes  *(re-shot)*
The left client on its own: the window where the drag happened, `live 7 ticks`.
**Alt:** "Reef board in the first window right after dragging an issue into the Done column."

### live-sync-b.png — 1440x757, 123,718 bytes  *(re-shot)*
The second client on its own, same instant: same board, `live 2 ticks`, no interaction here.
**Alt:** "Reef board in a second window showing the issue that was just moved in the first window, updated live."

### live-sync.gif — **900x1170, 383,834 bytes, 6.16s, 4 frames, loops**  *(re-shot, then rebuilt stacked)*
**REBUILT, and the layout changed: the two windows are now STACKED, not side by side.**
Same three real states as before, from the same three full-resolution paired captures
(`scratchpad/frames2/pair-0{0,1,2}.png`, 2896x757 each — keep them, they are the master):
the starting board, then "Waiver e-signature at checkout" moved Todo → In Progress, then
"Group booking discounts" moved In Progress → Done. The left pane's tick counter climbs
5 → 6 → 7, the right pane's 0 → 1 → 2.

Each pane is cropped to the **Todo / In Progress / Done** columns (box `345,0 1066x672` inside the
1440x757 window; x=345 keeps the whole `ADMIN` badge and leaves a 13px sliver of Backlog at the
left edge, which reads as "the board continues off-frame"). Window A goes on top, window B below,
each with a 1px rule and a drawn-in caption strip:
*"WINDOW A — the cards are dragged here"* / *"WINDOW B — nobody is touching it — db.live pushes
the change"*, in the same style as `masked-note-compare.png`. The composite is then downscaled to
900 wide (lanczos) purely to fit the byte budget.

**Why stacked.** Side by side, each window can only get half the figure's width, so at the 600-720px
the pages actually render it every card title lands at 3-4px — that was review 2 MAJOR-2. Stacked,
each window gets the full width: 0.55 scale at the landing's 600px and 0.66 at the 720px content
column, i.e. 8-10px card titles. Verified frame by frame at 599px and in Chrome at 600px and 720px.
**Cost of the change: the figure is now portrait.** It renders 600x779 on the landing, 720x935 on
tour-of-reef and live-queries, 676x878 on the quickstart — where a 1920x502 banner used to be.
Any page that laid out a wide strip beside prose needs to look at that row again.

**Alt (suggested):** "Two Reef windows stacked one above the other: cards dragged in the top window
appear in the same columns in the bottom window, whose live tick counter climbs from none to two."
**Caveats:** unchanged from the previous build — the two moves were driven programmatically (HTML5
`DragEvent`s through the app's own handlers), so there is **no cursor and no drag animation**; the
cards cut from one column to the next. Frames are held 1.8s / 1.8s / 2.6s. Encoded with ffmpeg
`palettegen(stats_mode=diff, max_colors=80) + paletteuse(dither=none, diff_mode=rectangle)`;
80 colours is the floor at which the red `bug` chip and the amber "In Progress" dot survive
quantisation — at 64 they both go grey. Build script: `scratchpad/ff4-gif.mjs`.

⚠️ `live-sync.png` / `live-sync-a.png` / `live-sync-b.png` were **not** rebuilt, so the static
twin no longer matches the GIF's framing. All three are unreferenced.

### workspaces.png — **584x420, 16,852 bytes**  *(cropped)*
**CROPPED** to the two panels: box `428,190 584x420`. Kept: the "YOUR WORKSPACES" panel with both
rows and their `db/…` names, and the "NEW WORKSPACE" panel with the `Coral Team` placeholder and
"the name becomes the database". Dropped: the app header, the "Hi, Ada" heading and its
`ramose.db(slug)` explainer sentence. Both current alts still describe what is visible.

The workspace picker with two entries — "Coral Reef Divers" (`db/coral-reef-divers`) and
"Kelp Forest" (`db/kelp-forest`) — plus the "New workspace" card and its
`ramose.db(slug)` explainer.
**Alt:** "Reef workspace picker listing two workspaces, Coral Reef Divers and Kelp Forest, each labelled with its own Ramose database name."

### sign-in.png — **520x620, 33,037 bytes**  *(cropped)*
**CROPPED** to the card: box `460,68 520x620` — the card is 398x484 with a 61px margin left/right
and 68px top/bottom, so the glow behind it still reads. Everything the alts name (logo, "Welcome
back", email, password, Sign in, and the Live / Multi-tenant / Time travel strip) is inside the
crop. Renders 1:1 at 520px in the 720px content column, centred.

The auth screen in sign-in mode: "Welcome back", email + password, and the Live / Multi-tenant /
Time travel feature strip, over the two soft radial glows.
**Alt:** "Reef sign-in screen: a dark card with email and password fields over a soft blue glow, above Live, Multi-tenant and Time travel feature notes."
**Caveats:** centre-cropped from a 1450x840 capture (the card stays optically centred, within 1px).

### sign-up.png — **520x676, 32,781 bytes**  *(cropped)*
**CROPPED** to the card: box `460,40 520x676` (the card is taller than the sign-in one because of
the Name field). Still unreferenced by any page; cropped only so it stays a drop-in twin of
`sign-in.png`.

Bonus, not requested. Same screen in sign-up mode ("Create your account", with the Name field).
Useful if the landing page wants the fuller card.
**Alt:** "Reef account creation screen with name, email and password fields and the product's Live, Multi-tenant and Time travel highlights."
**Caveats:** same centre-crop as sign-in.png.

### invite.png — **720x380, 19,196 bytes**  *(cropped)*
**CROPPED** to the dialog plus a band of the dimmed board: box `360,54 720x380`. Starts just below
the app header so no half-header sliver shows. The dialog (479x269) keeps 38px of dimmed board
above and 73px below, so "over a dimmed board" in both alts is still true. Renders 1:1 at 720px.

The "Invite to this workspace" dialog over the dimmed board: email `grace@example.com` and the
role select showing "viewer — read-only by policy".
**Alt:** "Reef invite dialog over a dimmed board, with a teammate email filled in and the role set to viewer, read-only by policy."
**Caveats:** the invite was **composed but not sent** — I filled the dialog and cancelled, so no
invitation row was created and no member list exists. There is no separate members dialog in
Reef; this dialog is the whole membership surface.

## Extra shots (requested after the primary list)

The workspace now has three members: **Ada Lovelace** (owner/admin),
**Grace Hopper** (grace@example.com, viewer) and **Linus Pauling** (linus@example.com, member).
Both were invited through the real Invite dialog and accepted through the real invitation card.
Passwords for all three are `reef-demo-2026` if you need to re-enter as any of them.

### denied-toast.png — 1440x757, 130,126 bytes  *(re-shot)*
**Load-bearing.** Signed in as **Marie Curie**, a **viewer**. She forced a card move
("Nitrox certification check on booking", In Progress → Done) and the peer refused it: the red
toast reads **"retract denied on :issue/status"**. The card never moved (Reef does not update
optimistically, so it simply stays put), the header carries the `VIEWER` badge and her MC
avatar, and the column "+" buttons and the Invite button are absent for her class. The board
behind shows the current three-avatar assignment, so it matches `board-dark.png` directly above
it on the landing page.
**Alt:** "Reef board as a viewer: a forced card move is rejected by the server with a red toast reading retract denied on :issue/status, and the card stays in its column."
**Caveats:** now 1440x757 like everything else — the earlier 1440x883 version is gone, so the
"one file is a different height" warning no longer applies. The drag was fired through the app's
own HTML5 drag handlers, so there is no cursor mid-drag.

**Why Marie and not Grace, which matters if you re-verify this shot.** Re-shooting it as Grace
exposed a side effect of the role round-trip I did to get her avatar onto the board: because she
now owns a `:user` row, `myEid` is defined for her, so `canWrite` is true and **the column "+"
buttons appear on her board even though she is a viewer**. The peer still refuses her writes —
the denial toast is identical — but the screenshot would have contradicted the README's claim
that a viewer's UI is "polite (no + buttons)", and a reviewer checking the docs against the
image would have flagged it. So I invited a fourth member, **Marie Curie**
(marie@example.com, viewer, password `reef-demo-2026`), who has never written anything and
therefore has no user row and the true out-of-the-box viewer UI. She is the account to use for
verifying the denial. Grace remains a viewer whose UI is slightly over-permissive-looking; that
is a real, if minor, quirk I introduced, and it is confined to her account.

### masked-note.png — 1440x757, 207,035 bytes
The issue detail panel as a **member** (Linus). The Admin note section shows the
`MASKED FOR MEMBER` tag and the placeholder "Read-masked for your class — a write here is denied
by the peer" where the admin sees real text, with the `issue.privateNote` explainer underneath.
The `MEMBER` badge is in the header, and the column "+" buttons are present (members can write).
**Alt:** "Reef issue detail as a member: the admin note is tagged masked for member and its content is redacted by the server, unlike the visible description above it."

### masked-note-compare.png — 836x853, 110,117 bytes
The "better" version: the same issue panel side by side, **admin (note visible) vs member (note
masked)**, captioned. Everything above the note — status, priority, assignee, labels, description
— is identical; only the admin note differs, which is exactly the point.
**Alt:** "Two Reef issue panels side by side: identical except the admin note, which shows real text for an admin and a redacted placeholder for a member."
**Caveats:** a composite I assembled from two real captures (panels cropped, 20px gutter, captions
drawn in). Panel crop only — no board or header behind it.

### masked-note-viewer.png — 1440x757, 208,541 bytes
Bonus. Same as masked-note.png but as a **viewer** (Grace) — the tag reads `MASKED FOR VIEWER`,
the "+" buttons are gone, and the comment composer is disabled. Use if a page needs the strictest
class rather than a member.
**Alt:** "Reef issue detail as a viewer: the admin note is tagged masked for viewer and redacted, and the comment box is disabled."

### workspace-create.png — **616x536, 28,273 bytes**  *(cropped; see the third-pass entry below too)*
**CROPPED** to the picker: box `412,90 616x536`. Kept: the "Hi, Ada" heading and its
`ramose.db(slug)` line, the two-workspace panel, and the New workspace form with `Tidepool` and
the `→ ramose.db("tidepool").install()` preview. Dropped: the app header only. Both alts still
match. Renders 1:1 at 616px.

The "New workspace" form filled in with **Tidepool**, showing the live db-name preview
`→ ramose.db("tidepool").install()` under the field, above the existing two-workspace list
(Coral Reef Divers, Kelp Forest).
**Alt:** "Reef new-workspace form with the name Tidepool typed in, previewing the database call ramose.db(\"tidepool\").install() it will run."
**Caveats:** the form was not submitted — no `tidepool` workspace exists.
**Provenance:** I originally shot this with the name "Coral Team" as briefed; **another agent
later overwrote the file** with this Tidepool version. I have kept theirs rather than fight over
the file, because it is arguably the better shot: `coral-team` is already a taken slug in this
local dev D1 (left over from an earlier e2e run), so a form promising
`ramose.db("coral-team").install()` would depict a create that cannot actually succeed.
`tidepool` is free. Flagging it because it means **this directory has more than one writer** —
if byte sizes in this manifest ever disagree with disk, disk wins and something re-shot it.

### invitation.png — 1440x757, 42,936 bytes
Bonus, the other half of the invite story: Grace's workspace picker with an Invitations card
reading "Coral Reef Divers — invited as viewer" and an "Accept & open" button, above her
(still empty) workspace list.
**Alt:** "Reef workspace picker for an invited user, showing a pending invitation to Coral Reef Divers as viewer with an Accept and open button."

### todos-app.png — DOES NOT EXIST, do not reference it
No such file was produced. Skipped deliberately. `bun run dev:todos` binds the same ports as reef (peer :1337, Vite :5173
with `--strictPort`), so the two cannot run together, and W2 needed those ports for their own
todos dry-run. Capturing it would have meant taking reef down mid-shoot and fighting W2 for the
ports. It was marked optional; ask me and it is ~10 minutes once the ports are free.

## What I could NOT get, and why

1. ~~A second human user and role badges.~~ **Done — I was wrong.** My first reading was that
   the single trusted origin (`trustedOrigins: [DEV_UI_ORIGIN]`, `src/infra/api.ts:80`, and
   `RAMOSE_ALLOWED_ORIGINS`, `src/infra/resources.ts:63`, both `http://localhost:5173` only)
   made a second user impossible. That is only true for **simultaneous** sessions — two users
   signed in at once in one Chrome profile. The role shots need **sequential** sessions, which
   work fine: invite, swap the session cookie, capture, swap back. Grace (viewer) and Linus
   (member) are now real members and `denied-toast.png`, `masked-note.png`,
   `masked-note-compare.png` and `masked-note-viewer.png` are all genuine.
   **Also now fixed:** the board shots showed only Ada's "AL" avatar because they predated
   Grace and Linus. Assignees are now spread across all three, and
   `board-dark`/`board-light`/`issue-detail`/`live-sync*`/`live-sync.gif` have been re-shot.

   **How Grace became assignable, stated plainly.** A viewer never gets a `:user` row —
   `ensureSelf` (mutations.ts) skips the write when `canWrite` is false, and an admin cannot
   create one on her behalf because `:user/sub` is a preset attribute pinned to the caller. So a
   viewer can never be an assignee. To get her avatar onto the board without leaving her a
   member (which would have quietly falsified `denied-toast.png` for any reviewer who checked
   her role against the live app), I promoted Grace to member via
   `organization/update-member-role`, had her sign in once so she wrote her own user row, then
   demoted her straight back to viewer. The row persists — the log is immutable — so she is
   assignable *and* still a viewer. Verified after the fact: roles are
   `ada=owner, grace=viewer, linus=member`, and `denied-toast.png` is still reproducible
   step for step. If that round-trip bothers anyone, the alternative is to drop Grace from the
   board shots and use Ada + Linus only.

   `denied-toast.png` has since been re-shot too, so it carries the current avatars.
   Two shots still show the pre-reassignment board behind their subject —
   `masked-note.png` and `masked-note-viewer.png` — left that way deliberately: their subject is
   the panel, the board is peripheral, and re-shooting each costs a session swap.
   `masked-note-compare.png` is panel-only, so it is unaffected. `time-travel.png` legitimately
   shows the old assignments because `db.asOf(27)` predates the reassignment, which is exactly
   what a time-travel view should do — do not "fix" it.

2. **Two real OS windows in one frame.**
   The capture API is per-tab (`chrome.tabs.captureVisibleTab`), so it can never photograph two
   windows at once, and there is only one Chrome window on a single 1080p display.
   `resize_window` had no effect on the captured viewport (AppleScript could move the window,
   but the renderer kept its pinned viewport). `live-sync.png` and `live-sync.gif` are therefore
   honest composites of two *simultaneous, independent* clients rather than a single grab.
   The `live-sync-a.png` / `live-sync-b.png` pair is the un-composited fallback.

3. **Device pixel ratio 2.** Non-Retina 1080p display; `devicePixelRatio` is 1.

4. **A workspace literally named "Coral Reef".**
   The slug `coral-reef` is already taken in the local dev D1 by a leftover synthetic user from
   an earlier e2e run (`ada+1787021875985@example.com`), and Better Auth rejects the create with
   "Organization already exists". The UI derives the slug from the name with no override, so I
   used **"Coral Reef Divers"** → `db/coral-reef-divers`, which is on-theme for a dive-booking
   team and keeps name and slug coherent. I deliberately did **not** delete or rename the
   stale org. If you want the exact name, delete organization
   `MHYYERFjRgvKgfOu8TtZGpqrDxmZBvGm` from the dev D1 and re-run.

5. **The time-travel graveyard** ("Deleted, still in history"). Needs a deleted issue; deleting
   was out of scope per instructions.

## Reef UI notes — things that looked rough or off-brand

1. **Real bug: the create-workspace button can get permanently stuck.**
   `examples/reef/src/app/screens/WorkspacesScreen.tsx` — `create()` does `setBusy(true)` and
   only calls `setBusy(false)` in the `catch`. On success it calls `onCreate(...)` and leaves
   `busy` true forever. That is fine when entry succeeds (the screen unmounts), but if
   `openWorkspace` then throws, you are returned to a picker whose Create button is disabled
   until a full reload. I hit this on my first attempt and it cost real debugging time.

2. **`checkSlug` is dead code.** `src/app/auth.ts` exports it, nothing calls it. The slug
   collision above surfaces as a raw Better Auth string ("Organization already exists") in a
   toast rather than as inline validation next to the live `ramose.db("coral-reef")` preview,
   which is where the user is already looking.

3. **Labels are missing from the New issue dialog.** The dialog has Title, Description,
   Priority and Assignee, but labels can only be set afterwards from the detail panel — so every
   labelled issue costs a second round trip. This was the single most tedious part of seeding.

4. **Columns are mostly empty space.** With 3-4 cards a column is ~85% blank at 757px tall.
   It photographs as a sparse board; a shorter `minHeight` or a subtle end-of-column affordance
   would make screenshots (and the product) look denser.

5. **The comment delete "×" is always visible**, sitting right next to the timestamp on every
   comment rather than appearing on hover/focus. It reads as visual noise in the detail panel
   and is easy to hit by accident.

6. **"No priority" is nearly invisible.** The priority glyph for level 0 is a very faint bar
   chart that is hard to distinguish from Low at a glance on a card.

7. Minor: the empty-board "Add sample issues" seed contains titles that leak internals
   ("Per-datom policy for issue.privateNote", "Rotate the JWKS signing key on a schedule").
   Fine for a developer demo, wrong for any marketing screenshot — worth knowing if anyone
   photographs the empty state later.

## Dev server — RUNNING

- `bun run dev:reef` from `/Users/tvanhens/git/ripple`, **PID 49490**.
- Vite `http://localhost:5173`, auth Worker `http://localhost:1338`, peer `http://localhost:1337`.
- Log: `…/scratchpad/reef-dev.log`. Stop with `kill 49490` if the ports are ever needed.
- Sign-ins for reviewers, all password `reef-demo-2026`:
  `ada@example.com` (admin/owner), `linus@example.com` (member),
  `marie@example.com` (viewer — **use this one to verify the denial toast**),
  `grace@example.com` (viewer, but she owns a user row so her board shows "+" buttons the peer
  still refuses — see the denied-toast.png notes).
- The browser is left signed in as Ada.

It was briefly stopped between passes to unblock W2's `dev:todos` dry-run (todos binds the same
ports with `--strictPort`); that agent died before running it, and reef is back up and staying up.
`todos-app.png` was never captured for the same port reason.

**All the seeded data survives a restart** — the board, the three members, the comments and the
transaction history live in `.alchemy/local` (R2 + DO storage) and the auth D1, both on disk. So
re-shooting or adding shots later needs no re-seeding: restart, sign in as
`ada@example.com` / `reef-demo-2026`, open Coral Reef Divers.

### Two things I had to fix to get it up

1. `bun install` was stale — `zod` was not linked, so `@ramose/better-auth` failed to import.
   Re-ran `bun install` (no tracked file changed; `git status` stayed clean).
2. The local Alchemy state carried an orphaned `Ripple.Server` row from before the Ramose
   rebrand, which made `alchemy dev` refuse to plan. I **moved it aside** (did not delete) to
   `…/scratchpad/alchemy-state-backup/reef-Ripple.json`; the current stack recreated the row as
   `Ramose`. `.alchemy/` is gitignored local dev state. Restore by moving that file back to
   `/Users/tvanhens/git/ripple/.alchemy/state/ripple-reef/dev_tvanhens/Ripple.json`.

No repo source files were edited. The only additions are the images under
`website/public/reef/`.

---

## Third pass — the three missing files (appended by a second screenshot agent, 11:47)

I was sent in to capture `denied-toast.png`, `masked-note.png` and `workspace-create.png`, which
were still missing / broken when I started. **I did not know another agent was working the same
directory**, and I overwrote two of its files before I noticed. What is on disk now is described
here; where I clobbered something, I say so and what I did about it. **Disk wins over any byte
count earlier in this file.**

All three are 1440x757, dark theme, PNG (sharp `palette:true, quality:90`, same settings as the
first pass), captured from `Coral Reef Divers` on the same seeded board.

### denied-toast.png — 1440x757, 129,197 bytes  *(re-shot a third time — replaced the 130,126-byte version)*
**Load-bearing.** Signed in as **Rosalind Franklin** (`rosalind@example.com`, viewer, no `:user`
row, so this is the true out-of-the-box viewer UI: no column "+" buttons, no Invite button).
She forced #1028 "Add keyboard shortcuts for moving cards" from **Todo → In Progress**; the peer
refused and the red toast reads **`retract denied on :issue/status`**. The card is still in Todo
(Reef never updates optimistically, so it does not visibly snap back — it never moves), the
header carries the `VIEWER` badge and her `RF` avatar, and the board behind shows the current
GH/LP/AL assignee avatars, so it matches the current `board-dark.png`.
**Alt:** "Reef board as a viewer: a card drag is refused by the server with a red toast reading retract denied on :issue/status, and the card never leaves its column."
**Caveats:** the drag was dispatched through the app's own HTML5 drag handlers
(`dragstart`/`dragover`/`drop` with ~200ms between them — fired back-to-back in one tick, React
has not committed `dragId` yet and the drop is a no-op), so there is **no cursor and no mid-drag
ghost**. Equivalent in every documented respect to the Marie Curie version I replaced; only the
avatar (RF vs MC) and which card was dragged differ.

### masked-note.png — 1440x757, 202,648 bytes  *(re-shot by me after I clobbered the previous one)*
The issue #1030 detail panel as a **member** (Linus Pauling): `MEMBER` badge in the header,
`ADMIN NOTE` tagged **`MASKED FOR MEMBER`**, the field empty with the placeholder "Read-masked for
your class — a write here is denied by the peer", and the `issue.privateNote` explainer beneath.
Column "+" buttons are present (members can write). This matches the alt text the docs already
carry ("masked-for-member").
**Alt:** "Reef issue detail as a member: the admin note is tagged masked for member and its content is redacted by the server, while the description above it is fully visible."
**Caveats:** **I overwrote the previous member shot with a viewer one by mistake, then re-shot
this member version to restore it.** The byte count therefore differs from the 207,035 recorded
above; the content is the same subject. The viewer variant lives on unchanged as
`masked-note-viewer.png`.

### workspace-create.png — **616x536, 28,273 bytes**  *(re-encoded here, then cropped by FF4)*
The "New workspace" form with **Tidepool** typed in and the live preview
`→ ramose.db("tidepool").install()` under the field, above Ada's two-workspace list (Coral Reef
Divers, Kelp Forest). Not submitted — no `tidepool` workspace exists.
**Alt:** "Reef new-workspace form with the name Tidepool typed in, previewing the database call ramose.db(\"tidepool\").install() it will run."
**Caveats:** this is the same capture documented above at 122,236 bytes; I had written that one
with PIL, and re-encoded it through the same sharp settings as the rest of the set (hence
39,192 bytes). Note the docs caption at `quickstart.mdx:56` still says **"Coral Team"** /
`ramose.db("coral-team").install()` — it must be reworded to Tidepool, or the shot re-taken.

### masked-note-pair.png — DELETED, do not reference
I built an admin-vs-viewer full-window pair (2896x757) before noticing that
`masked-note-compare.png` already covers that ground better (panel-only, captioned, admin vs
member). I deleted my file to keep one obvious asset per slot.

## Things the next person needs to know

1. **This directory and this file have at least two writers.** Two screenshot agents ran
   concurrently. If a byte count here disagrees with disk, disk wins.
2. **The browser profile has ONE shared cookie jar, and it was being driven by both of us.**
   Mid-task the session flipped Ada → Grace → Marie → Ada under me; an invite sent "as Ada"
   failed with "You are not allowed to invite users to this organization" purely because the
   session had become Grace's (a viewer) between page load and click. If a Reef action fails
   inexplicably, check `fetch('/api/auth/get-session')` before believing it is a Reef bug.
3. **New account:** `rosalind@example.com` / `reef-shots-2026`, **viewer** in Coral Reef Divers,
   never written anything (no `:user` row) — the cleanest account for re-shooting viewer UI.
   Other accounts are all `reef-demo-2026` as recorded above.
4. **Dev-DB litter I added:** a `Probe Org` (`db/probe-1787078285`) plus
   `probe1787078285@example.com`, from a probe I ran to work out whether the invite failure was a
   Reef bug (it was not). Marie is a member of it. Harmless; delete from the auth D1 if it
   bothers you. Nothing was deleted from the DB.
5. **The dev server died and I restarted it.** At 18:21 UTC `alchemy dev` for reef exited 143
   (SIGTERM, ports went dead mid-session). I restarted it with `bun run dev:reef`; Vite :5173,
   auth :1338, peer :1337 all came back and all seeded data survived. There are now two
   `alchemy dev examples/reef` process groups alive (PIDs ~49491 and ~49990); only one holds the
   ports. Kill the idle one if it gets in the way.
6. **Capture geometry gotcha.** A tab's viewport is pinned when the tab is created: resizing the
   window does nothing to tabs that already exist. Set the window size first
   (`resize_window` — 1440x950 outer gives a 1440x757 viewport here), *then* create the tab.
   Also, `computer` screenshots are only written to disk when you pass `save_to_disk: true`, and
   any capture over ~1.2 megapixels is silently downscaled (a 1440x883 viewport comes back as
   1400x858), which is what makes 1440x757 the sweet spot.

---

## Crop pass (FF4, 2026-08-18 13:30) — review 2 MAJOR-2 and MINOR-3

Review 2 measured the figures **on the rendered page** and found half of them too small to read:
`live-sync.gif` at 0.31 scale ("two grids of grey smudges — you cannot tell which card moved"),
`sign-in.png` at 0.47 with the card ~9% of the frame, `workspaces.png` and `time-travel.png` at
0.30. The one that worked, `masked-note-compare.png` at 0.86, was cropped to its subject — so
every centred-card screen was cropped to its subject too, and the GIF was rebuilt from its
full-resolution sources.

**No page was edited by this pass.** `Shot.astro` measures dimensions from the file at build time,
so pages pick the new sizes up on the next build. Only the two ⚠️ items at the bottom need a human.

### What changed

| File | Before | After | Bytes | Crop box (in the 1440x757 capture) |
|---|---|---|---|---|
| `sign-in.png` | 1440x757 | **520x620** | 62,482 → 33,037 | `460,68 520x620` |
| `sign-up.png` | 1440x757 | **520x676** | 48,957 → 32,781 | `460,40 520x676` |
| `workspace-create.png` | 1440x757 | **616x536** | 39,192 → 28,273 | `412,90 616x536` |
| `workspaces.png` | 1440x757 | **584x420** | 37,523 → 16,852 | `428,190 584x420` |
| `invite.png` | 1440x757 | **720x380** | 48,339 → 19,196 | `360,54 720x380` |
| `time-travel.png` | 1440x757 | **718x540** | 103,391 → 40,065 | `712,0 718x540` |
| `board-dark.png` | 1440x757 | **1440x580** | 122,072 → 105,590 | `0,0 1440x580` (MINOR-3) |
| `board-light.png` | 1440x757 | **1440x580** | 114,237 → 97,526 | `0,0 1440x580` |
| `live-sync.gif` | 1920x502 | **900x1170** | 363,591 → 383,834 | rebuilt — see its entry |

Untouched: `issue-detail`, `denied-toast`, `masked-note`, `masked-note-viewer`,
`masked-note-compare`, `invitation`, `live-sync{,-a,-b}.png`.
Scripts: `scratchpad/ff4-crop.mjs` (idempotent — it reads pristine copies from
`scratchpad/ff4-orig/`, so re-running it re-derives every crop) and `scratchpad/ff4-gif.mjs`.

### Measured on the rendered page afterwards (Chrome, 1440 CSS px)

Every figure is now at or near 1:1, and `Shot.astro`'s `max-width:min(100%,Wpx)` centres the
narrow ones in the 720px content column.

| Figure | landing | tour-of-reef | quickstart | guide |
|---|---|---|---|---|
| `live-sync.gif` | 600x779 | 720x935 | 676x878 | 720x935 (live-queries) |
| `sign-in.png` | — | 520x620 (1:1) | — | 520x620 (1:1) |
| `workspaces.png` | 584x421 (1:1) | 584x421 (1:1) | — | — |
| `time-travel.png` | 718x540 (1:1) | 718x540 (1:1) | 676x509 | 718x540 (concepts) |
| `invite.png` | — | 720x381 (1:1) | — | 720x381 (1:1) |
| `workspace-create.png` | — | — | 616x536 (1:1) | 616x536 (1:1) |

No horizontal overflow at 380px (`documentElement.scrollWidth === 380`).
`bun run check`: **0 errors, 15 warnings** before and after — the crop pass changed neither.

### ⚠️ Two things a page owner must do

1. **`index.mdx:24`** — the landing hero is a raw `<img … width="1440" height="757">`, not a
   `<Shot>`, so it is the one place that does not re-measure. Change to `height="580"`.
2. **`quickstart.mdx:84`** — the alt reads *"…with the slider mid-track and the header pill reading
   paused, showing fewer cards than live"*. The crop moves the handle to the left edge of the
   frame. Suggested replacement:
   *"Reef's board under a blue time-travel bar reading db.asOf(27) of 42, the header pill reading
   paused, showing fewer cards than live"*.

Every other alt and caption was checked against its new crop and still describes what is visible —
including `tour-of-reef.mdx:260` ("fewer cards in every column than the live board": In Progress 2
and Done 3 are both visibly shorter than the live board's 4 and 4) and the three captions that say
"the live pill pulses on every update" (the pill is inside the GIF's crop in both panes).
The `live-sync.gif` alts on all four pages still read true, but they all say "side by side"
or "left/right"; the stack makes "top/bottom" more accurate. Suggested wording is in the
`live-sync.gif` entry above.

### What FF4 did not do

- **`time-travel.png` cannot be cropped narrow without lying.** Getting it under ~600px means
  either dropping the `db.asOf(27) / 42` chip that five alt texts and two captions cite, or
  chopping the "Read-only view as of transaction 27…" sentence mid-word. The 718px crop is the
  best clean boundary; see its entry for the slider-position caveat.
- **Nothing was re-recorded from the live app.** Re-shooting time travel would renumber
  `db.asOf(27) of 42` (the board has had transactions since), which would falsify five alt texts
  and two captions for no legibility gain the crop does not already deliver.
- **MINOR-5 is still open**: `masked-note-compare.png` has the word "datom" baked into it twice.
  Fixing it means changing the helper string in `examples/reef` and recapturing — app source, not
  an image job.
- **MINOR-9 (7 unused assets) was left alone.** Deleting them is destructive and was not in the
  brief; `board-light.png` joined the list only because the landing stopped using it.
