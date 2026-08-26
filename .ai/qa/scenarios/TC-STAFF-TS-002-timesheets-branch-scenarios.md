# TC-STAFF-TS-002 — Timesheets testable scenario catalogue (`feat/timesheets-ux-improvements`)

> **Type:** Scenario catalogue — the full testable surface of the timesheets feature as it stands on this branch after the `upstream/develop` merge.
> **Branch:** `feat/timesheets-ux-improvements` (merge `553bf3149`, 1544 upstream commits + 37 branch commits)
> **Module:** `packages/core/src/modules/staff/` (timesheets area)
> **Companion:** [`TC-STAFF-TS-001`](TC-STAFF-TS-001-timesheets-manual-qa.md) covers the pre-existing baseline surface (timer, entries, projects, membership, ACL). **Do not duplicate it** — TS-002 covers what this branch changed plus what the merge newly brought in, and re-points TS-001 rows only where branch behaviour changed underneath them.

## How to read the Coverage column

| Marker | Meaning |
|---|---|
| **AUTO** | An executable Playwright spec already asserts this — `yarn test:integration`. Re-run, don't re-test by hand. |
| **UNIT** | A jest unit/contract test asserts it. Cheap regression signal, but not end-to-end. |
| **MANUAL** | No automated coverage. Needs a browser pass. **These are the rows that earn QA time.** |
| **GAP** | No coverage and a good automation candidate — listed in § 9. |

---

## 0. Environment & preconditions

- **Build the branch app**: `yarn build:packages` → `yarn generate` → `yarn build:packages` → `yarn build:app`, then serve. The dev server on this checkout **does not hydrate** (SSR renders, no client JS), so every interactive scenario below needs a production build.
- **Two accounts** are required throughout:
  - **Admin** — `staff.*` (manage all entries, manage projects, assign members).
  - **Employee** — `staff.timesheets.view`, `.manage_own`, `.projects.view` only.
- Both users **must be linked to a staff member**, or every page short-circuits on `staff.timesheets.errors.noStaffMember`.
- **Seed data matters for this branch.** The seeding ladder (§ 3) is only meaningful with controlled project counts. Prepare three employees: one with **0** assigned projects, one with **exactly 1**, one with **several** (≥3, at least 2 grid-visible).
- Use **two browser contexts** (normal + incognito) for the concurrency and cross-surface rows.

**Surfaces under test**

| Surface | Route |
|---|---|
| My Timesheets (timer + grid) | `/backend/staff/timesheets` |
| Projects portfolio | `/backend/staff/timesheets/projects` |
| Project details / create / edit | `/backend/staff/timesheets/projects/{id}`, `/create`, `/{id}/edit` |
| Dashboard widget — Time Reporting | Dashboard |
| Sidebar running-timer indicator | injected, all backend pages |

**API surface**

`GET|PUT /api/staff/timesheets/my-preferences` · `GET|PUT /api/staff/timesheets/my-projects[/{projectId}]` · `/api/staff/timesheets/time-entries[/bulk|/start-timer|/{id}/timer-start|/{id}/timer-stop|/{id}/segments[/{segmentId}]]` · `/api/staff/timesheets/time-projects[/{id}/employees]` · `/api/staff/timesheets/projects/kpis`

---

## 1. P0 — Timer start/stop as commands (#2609, #3717)

The branch moved both timer routes onto the command bus so the list cache is invalidated and the operation is undoable. This is the highest-risk area on the branch: the routes were rewritten wholesale.

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| CM1 | Start a timer on an existing entry; observe the entries list without a manual refresh. | List reflects the running entry immediately — no stale cached page. | **AUTO** `TC-STAFF-031` |
| CM2 | Stop a running timer; observe the list without a refresh. | Duration and `endedAt` appear immediately; the row leaves the running state. | **AUTO** `TC-STAFF-029` |
| CM3 | Start a timer, then **undo** via the operation toast. | Entry returns to not-started; the initial work segment is removed; no orphan segment remains. | **UNIT** only — **GAP** end-to-end |
| CM4 | Stop a timer, then **undo**. | Timer returns to running; `endedAt` cleared; duration reverts. | **UNIT** only — **GAP** end-to-end |
| CM5 | Response carries the `x-om-operation` header on both start and stop. | Header present with `resourceKind: staff.timesheets.time_entry`, an undo token and a command id. | **UNIT** |
| CM6 | **Double-click Start** rapidly (or two tabs, same entry). | Exactly one start wins; the loser gets `409 timerAlreadyStarted`. Exactly **one** work segment exists. | **MANUAL** (race) |
| CM7 | Start a second timer while another is already running (second tab / dashboard widget). | `409 timerAlreadyRunning` — *"Another timer is already running. Stop it before starting a new one."* Never two running entries. | **MANUAL** (race) |
| CM8 | Stop an already-stopped entry. | `409 timerAlreadyStopped`, no duplicate segment close. | **UNIT** |
| CM9 | Start a timer on **another user's** entry. | `403 notOwner`. Note: `manage_all` does **not** bypass here — this is deliberate, the command declines to widen RBAC. | **UNIT** |
| CM10 | Start/stop on an entry in **another organization**. | `404 entryNotFound` — never cross-tenant data. | **MANUAL** |
| CM11 | Audit log after start and after stop. | Two distinct entries: *Start timer* / *Stop timer*. `start_timer_existing` must not be logged as `start_timer`. | **MANUAL** |
| CM12 | `staff.timesheets.time_entry.timer_started` / `.timer_stopped` events fire. | Both emitted persistently; a failing emit does **not** fail the request. | **UNIT** |

**Why CM6/CM7 matter:** they are the original "*start sometimes does not work*" report (#2456). The command holds a `PESSIMISTIC_WRITE` lock and re-checks under it, so the correct outcome is a clean 409 — not a silent second segment.

---

## 2. P0 — Running-timer lookup (`$exists`) (#3717)

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| RL1 | With a timer running, load any backend page. | The running timer resolves — TimerBar shows Stop, sidebar shows the indicator. | **AUTO** `TC-STAFF-030` |
| RL2 | `GET /api/staff/timesheets/time-entries?running=true`. | Returns the running entry. Under the old `$ne: null` shape this returned **zero rows always**. | **UNIT** |
| RL3 | Running lookup does **not** scope by date. | An **overnight** timer started yesterday still resolves today. | **UNIT** — **GAP** end-to-end |
| RL4 | `running=false` / absent. | No `started_at` / `ended_at` filter applied. | **UNIT** |
| RL5 | Running lookup combined with a project filter. | Both clauses applied together. | **UNIT** |

**Regression sentinel:** if TimerBar ever shows *Start* while a timer is genuinely running, suspect a null-equality filter has crept back. The unit test now asserts no clause compares against `null`.

---

## 3. P0 — Timer picker project seeding (#3750)

A pure resolver picks the seed; **first match wins**, and every rung is rejected unless the id is in the caller's assignable projects.

| Rung | Source | Seeds when |
|---|---|---|
| 1 | Running timer's project | a timer is running on an assignable project |
| 2 | Persisted `lastProjectId` | preference set and still assignable |
| 3 | Sole **grid-visible** project | exactly one `show_in_grid = true` |
| 4 | Sole **assigned** project | exactly one assignment |
| 5 | `null` | anything ambiguous |

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| SD1 | Timer running on project A; **refresh** the page. | Picker shows **A**. (The post-refresh defect.) | **AUTO** `TC-STAFF-033` |
| SD2 | Stop the timer, stay on the page. | Picker still shows the project just stopped — not blank. | **AUTO** `TC-STAFF-033` |
| SD3 | No running timer, `lastProjectId` = B, B assignable. | Picker shows **B**. | **AUTO** `TC-STAFF-034` |
| SD4 | Employee assigned to exactly one project, no preference. | Picker pre-selects it; **Start is immediately clickable**. | **AUTO** `TC-STAFF-035` |
| SD5 | Employee with several visible projects, no preference, no timer. | **No seed.** Start stays disabled with the hint. Guessing among equals would mislog time. | **AUTO** `TC-STAFF-036` |
| SD6 | Exactly one project has `show_in_grid = true` among several assigned. | That one seeds (rung 3). | **UNIT** |
| SD7 | `lastProjectId` points at a project the user is **no longer assigned to**. | Rung 2 rejected; falls through to rung 3/4/null. Start must never enable with a **blank label**. | **UNIT** |
| SD8 | Running timer on a project **not in** the picker's list. | Falls through to rung 2 rather than resolving to null. | **UNIT** |
| SD9 | User picks project C manually, then the preference fetch resolves late. | **C wins.** A late fetch must never clobber a deliberate pick. | **AUTO** `TC-STAFF-036` |
| SD10 | Seed applies **at most once per mount**. | Navigating away and back re-seeds; staying put does not re-seed after a manual change. | **UNIT** |
| SD11 | Seeding never writes `show_in_grid`. | The grid's curated row set is unchanged after any seed. | **MANUAL** |

---

## 4. P0 — Shared timesheet preference (#3750 Phase 2/3)

`staff_timesheet_preferences`, unique on `(organization_id, tenant_id, staff_member_id)`.

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| PR1 | `GET /my-preferences` with no row. | `200 { lastProjectId: null, updatedAt: null }` — absence is **not** an error. | **UNIT** |
| PR2 | `PUT` then `GET`. | Round-trips; `updatedAt` advances. | **UNIT** |
| PR3 | `PUT` with a project the caller is **not actively assigned to**. | `400`. | **UNIT** |
| PR4 | `PUT { lastProjectId: null }`. | Accepted — clearing is legal. | **UNIT** |
| PR5 | Unauthenticated / missing `staff.timesheets.manage_own`. | `401` / `403`. | **UNIT** |
| PR6 | A mutation guard blocks the `PUT`. | `422` (or the guard's status) and **nothing persisted**. | **UNIT** |
| PR7 | A guard returns `modifiedPayload`. | The **modified** value is persisted, not the original. | **UNIT** |
| PR8 | An `afterSuccess` guard callback throws. | The write **stays committed**; the error is logged, the request still succeeds. | **UNIT** |
| PR9 | Two concurrent `PUT`s for the same staff member. | Atomic upsert — exactly one row, last write wins, no unique-constraint 500. | **AUTO** `TC-STAFF-040` |
| PR10 | The endpoint is **self-only** — no `staffMemberId` parameter. | Cannot be used to read or write another member's default. | **MANUAL** |
| PR11 | Start a timer from the **dashboard widget**, then open the timesheets page. | The page's picker shows the same project. | **AUTO** `TC-STAFF-037` |
| PR12 | Start from the **page**, then open the dashboard widget. | The widget shows the same project. | **AUTO** `TC-STAFF-038` |
| PR13 | Legacy read-through: widget has `settings.lastProjectId` but the shared preference is null. | Legacy value is used, then **written through** to the shared store on the next successful start. | **MANUAL** |
| PR14 | Preference persists on **successful start only**. | Merely selecting in the dropdown, or stopping, does **not** change it. | **MANUAL** |
| PR15 | The preference write **fails** (500/offline) during a start. | The timer still starts. No error flash. The failure is logged only. | **UNIT** |
| PR16 | Preference is scoped per org. | Switching organization yields that org's own default. | **MANUAL** |

---

## 5. P1 — Disabled-Start hint (#3750 Phase 1)

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| HT1 | Projects exist, none selected. | Tooltip: *"Pick a project to start the timer"*. | **AUTO** `TC-STAFF-032` |
| HT2 | **Zero** projects assigned. | Tooltip: *"No projects assigned yet — ask an admin to assign you to one"* — must **not** point at an empty dropdown. | **AUTO** `TC-STAFF-032` |
| HT3 | Start is **enabled**. | No tooltip, and no extra DOM. | **UNIT** |
| HT4 | Screen-reader path. | The hint is wired via `aria-describedby`, not hover-only. Verify with a screen reader or the a11y tree. | **MANUAL** |
| HT5 | Hover a **disabled** button. | Tooltip still appears — disabled buttons emit no pointer events, so the trigger wraps a focusable span. | **MANUAL** |

---

## 6. P1 — Grid cell duration entry (merged from upstream + #3749)

The cell is now an `InlineInput` with a parser and per-cell validation. **This is where the merge did the most delicate work** — test it properly.

**Accepted formats** (`parseDurationInput`): empty → `0` · `8` / `1.5` / `1,5` (decimal hours) · `1:30` (clock) · `90m` / `1h` / `1h 30m` (units). Max **1440 min (24h)**.

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| DU1 | Enter `8`, `1.5`, `1,5`, `1:30`, `90m`, `1h 30m`. | All parse to the right minutes and render back as decimal hours. | **UNIT** |
| DU2 | Enter empty / whitespace. | Parses to `0`, not an error. | **UNIT** |
| DU3 | Enter `abc`, `1:70`, `--`. | `invalid` — cell shows the error style + *"Duration not recognised…"*. | **UNIT** |
| DU4 | Enter `25`, `1441m`, `24:01`. | `out_of_range` — *"Max 24h per day…"*. | **UNIT** |
| DU5 | Enter a negative value. | Rejected as `invalid`. | **UNIT** |
| DU6 | With an invalid cell present, click **Save**. | Save is **disabled**, and the banner reads *"Fix the highlighted durations to save"* — **not** "Unsaved changes". | **MANUAL** |
| DU7 | Fix the invalid cell. | Banner reverts to *"Unsaved changes"*; Save re-enables. | **MANUAL** |
| DU8 | **Reload/refetch** the grid with a cell error showing. | Cell errors are cleared along with dirty state — no stale error on fresh data. | **MANUAL** — merge-resolution row, **verify explicitly** |
| DU9 | Invalid cell announced to assistive tech. | `aria-invalid` set; the message is reachable via `aria-describedby`; an `sr-only` `role="alert"` carries it. | **MANUAL** |
| DU10 | **Dark mode**, a dirty (edited, unsaved) cell. | The typed value is **legible** — amber-on-dark, ~10:1 contrast. This is #3749: it previously rendered near-white-on-white at 1.01:1. | **UNIT** (DS contract) + **MANUAL** — **highest-value manual row** |
| DU11 | Dark mode, an **invalid** cell. | Error background + error text, both legible. | **MANUAL** |
| DU12 | Dark mode, a **clean** cell with a value vs an empty cell. | Value cells `text-foreground` + semibold; empty cells muted. Both legible. | **MANUAL** |
| DU13 | Weekend cells. | Render as `-`, not editable. | **MANUAL** |
| DU14 | Weekly vs monthly view. | Cell width/padding differ by view; values and totals stay correct. | **MANUAL** |

> **DU10 is the row most likely to regress.** The merge moved the dirty-cell foreground from the wrapper's `className` into the InlineInput's `inputClassName`. The DS contract test now asserts both halves, but only a real dark-mode screenshot proves the pixel outcome.

---

## 7. P1 — Save behaviour (branch UX change)

This branch **deliberately removed the unconditional save confirmation** for routine cell edits (a95705b4c). Upstream re-added a confirm dialog; the merge kept the branch's no-confirm behaviour and retained only upstream's invalid-cell guard.

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| SV1 | Edit cells, click **Save**. | Saves **immediately** — no confirmation dialog. | **MANUAL** — merge-resolution row, **verify explicitly** |
| SV2 | **Remove a row.** | Still confirms — row removal is destructive and keeps its dialog. | **MANUAL** |
| SV3 | Bulk save a mix of new + edited cells. | All persist in one `bulk` call (limit 200); new rows created, owned rows updated. | **AUTO** `TC-STAFF-027` |
| SV4 | Save with no changes. | Save disabled; no request fired. | **MANUAL** |
| SV5 | Save fails server-side. | Error flash; dirty state **retained** so nothing is silently lost. | **MANUAL** |
| SV6 | Save a cell on a project the user is not assigned to. | Rejected per row. | **MANUAL** |
| SV7 | `Cmd/Ctrl+Enter` submits, `Escape` cancels, in every dialog on the page. | Per the platform dialog rule. | **MANUAL** |

---

## 8. P1 — Progressive loading, timeouts & permission decoupling (a95705b4c)

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| PL1 | Open the page cold. | The **shell renders first**; a skeleton/`loadingContent` shows while projects and entries load independently. | **MANUAL** |
| PL2 | **Projects** request fails, entries succeed. | Partial-load banner: *"Some timesheet data could not be loaded. Try again."* The page does **not** blank out. | **MANUAL** |
| PL3 | **Entries** request fails, projects succeed. | Same partial-load banner; project rows still render. | **MANUAL** |
| PL4 | **Both** fail. | Error state + a working **Retry** control. | **MANUAL** |
| PL5 | A request exceeds **12s**. | `AbortController` fires; the timeout is surfaced as an error, not an infinite spinner. | **MANUAL** — **GAP** |
| PL6 | Click **Retry** after a failure. | Refetches; on success the error clears and data renders. | **MANUAL** |
| PL7 | Switch week/month while a load is in flight. | The focused date is preserved via `anchorDate`; no stale response overwrites newer state. | **MANUAL** — **GAP** |
| PL8 | Projects page: KPIs slow or failing. | **"Add Project"** and the PM tabs stay stable — permissions come from a dedicated feature check, **not** from the KPI payload shape. | **MANUAL** |
| PL9 | Projects page while the permission check resolves. | Shows *"Checking your project permissions…"* — now translated in all 5 locales. | **MANUAL** |

---

## 9. P1 — Timer description/notes while running (#2456)

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| DS1 | Edit the description **while the timer runs**. | Editable; persists. | **AUTO** `TC-STAFF-028` |
| DS2 | Edit the description, then **navigate away and back**. | Text survives — the original "description is lost" report. | **AUTO** `TC-STAFF-028` |
| DS3 | Edit the description, then **reload**. | Rehydrates from the server. | **MANUAL** |
| DS4 | Edit the description, then **stop** the timer. | Notes are preserved on the stopped entry. | **MANUAL** |
| DS5 | The description write fails. | Error surfaced; the running timer is **not** disturbed. | **MANUAL** |

---

## 10. P2 — i18n (#3748 + merge)

The branch translated the timesheets surface into **es** and **de**; the merge added the upstream **ko** locale and six new duration/confirm keys.

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| I1 | Switch to **Spanish**, walk the timesheets page + projects page. | No English leakage in labels, errors, tooltips or dialogs. | **MANUAL** |
| I2 | Switch to **German**, same walk. | Same. | **MANUAL** |
| I3 | Switch to **Korean**, focus the **10 keys added during the merge** (start/stop audit labels, preference errors, partial-load, retry, loading, both Start-disabled hints). | Korean, not English fallback. | **MANUAL** — merge row, **verify explicitly** |
| I4 | Duration error messages in es/de/ko. | The format hints use **locale-appropriate decimal separators** (`1,5` in es/de). | **MANUAL** |
| I5 | Spanish remove-row confirmation. | Uses Spanish angle quotes «…», per 03143f161. | **MANUAL** |
| I6 | `yarn i18n:check-sync` / `yarn i18n:check-usage`. | In sync across all 5 locales; zero missing keys. | **AUTO** (gate) |

---

## 11. P2 — ACL, ownership & tenancy

Features: `staff.timesheets.view` · `.manage_own` · `.manage_all` · `.projects.view` · `.projects.manage` · `.approve` · `.lock`

| ID | Scenario | Expected | Coverage |
|---|---|---|---|
| AC1 | Employee opens project **create/edit**. | Blocked — no `projects.manage`. | **MANUAL** |
| AC2 | Employee edits/deletes **another user's** entry. | `403 notOwner`. | **MANUAL** |
| AC3 | Admin with `manage_all` edits an employee's entry. | Allowed — **but not** for `timer-start`/`timer-stop` (see CM9). | **MANUAL** |
| AC4 | User with **no staff-member link**. | Clear `noStaffMember` message, no crash, on every timesheets surface. | **MANUAL** |
| AC5 | Wildcard ACL (`staff.*`). | Grants the timesheets features via wildcard matching. | **MANUAL** |
| AC6 | Org switch. | Timer, entries, projects, preferences and KPIs all re-scope. **No cross-org leakage.** | **MANUAL** |
| AC7 | Direct API call for another org's entry id. | `404`, never `403`-with-data or a populated body. | **MANUAL** |

---

## 12. Automation candidates (the GAP rows)

Ranked by value. These have no end-to-end coverage today and map to real defect classes:

1. **CM6 / CM7** — concurrent start races (double-click, two surfaces). The original #2456 "*sometimes doesn't work*" report. Needs two parallel contexts hitting `timer-start` on one entry and asserting exactly one segment + one 409.
2. **CM3 / CM4** — undo for timer start/stop. Commands ship undo state; nothing exercises it end-to-end.
3. **DU10 / DU11** — dark-mode legibility of dirty and invalid cells. A DS contract test guards the tokens; a screenshot comparison would guard the rendered result.
4. **PL5 / PL7** — the 12s timeout boundary and the in-flight view-switch race.
5. **RL3** — the overnight running timer (running lookup must ignore date).
6. **PR13** — the legacy widget-settings read-through and write-through.

Per `.ai/qa/AGENTS.md`, these belong in `packages/core/src/modules/staff/__integration__/` as `TC-STAFF-0XX-*.spec.ts`, self-contained (API fixtures created in setup, cleaned up in teardown, no reliance on seeded demo data). `/om-integration-tests` generates them from these rows.

---

## 13. Merge-sensitive rows — run these first

The `upstream/develop` merge resolved five conflicted files by hand. Each resolution has a row that proves it:

| Resolution | Proving row |
|---|---|
| timer-start / timer-stop kept on the command bus | **CM1, CM2, CM6, CM7** |
| `$exists` running lookup kept over upstream's `$ne: null` | **RL1, RL2** |
| #3749 dark-mode fix carried onto upstream's InlineInput markup | **DU10** |
| Branch's no-confirm save kept, upstream's invalid guard retained | **SV1, DU6** |
| Cell errors cleared on reload | **DU8** |
| es/de translations kept, upstream's new keys added; ko backfilled | **I1, I2, I3** |

A green run on those six groups is the minimum bar for calling the merge verified in the browser.
