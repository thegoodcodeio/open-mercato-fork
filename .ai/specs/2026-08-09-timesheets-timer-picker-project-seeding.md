# TimerBar — Link the Project Picker to Timesheet State

Upstream issue: [open-mercato/open-mercato#3750](https://github.com/open-mercato/open-mercato/issues/3750) (filed 2026-07-02 by `alinadivante`, label `feature`).

## TLDR

**Key Points:**
- `TimerBar`'s project picker on `/backend/staff/timesheets` is state disconnected from everything else on the page. `selectedProjectId` starts `null`, is never seeded, and the disabled Start button explains nothing.
- Two remedies, delivered as three phases: an explanatory hint on the disabled Start control, and deterministic seeding of the picker from state the page already holds.
- "Last used project" moves to a **shared server-side staff preference** consumed by both timer surfaces, replacing the dashboard widget's private per-widget copy.

**Scope:**
- Phase 1 — hint/tooltip on the disabled Start control (no dependencies, independently shippable).
- Phase 2 — `staff_timesheet_preferences` entity + `my-preferences` API + a pure precedence resolver seeding `TimerBar`.
- Phase 3 — migrate the Time Reporting dashboard widget onto the shared preference, with a read-through fallback and a deprecation window for `TimeReportingSettings.lastProjectId`.

**Concerns:**
- Seeding from a running timer depends on the `$exists` fix in `50cf84394`, which exists **only on this fork**. Upstream `develop` cannot resolve a running timer at all. See § Blocking Dependency.
- The issue text is partly stale: its claim that a timer "correctly resumes counting" after refresh has not been true upstream since `c573bb7bd` (2026-07-02).
- Seeding makes Start a single click, which introduces a new way to log time to the wrong project. See § Risk Register → *Accidental start on a stale default*.

---

## Overview

`/backend/staff/timesheets` is a staff member's own timesheet page. It stacks two things that look related and are not: a `TimerBar` at the top for starting/stopping a live timer, and a weekly grid below it listing the projects that member logs time against. The grid says "these projects are yours"; the timer bar acts as though it has never met them.

This spec connects the two, and in doing so unifies the "last used project" memory that currently exists in only one of the product's two timer surfaces.

> **Market Reference**: Studied **Toggl Track** and **Kimai** (both open source / open core, both timer-first time trackers).
> **Adopted** — Toggl's rule that the timer defaults to the last *started* entry's project rather than the last highlighted one, so an idle mis-click never becomes tomorrow's default; and Kimai's rule that a running timer is always authoritative over any stored default when the UI reloads.
> **Rejected** — Toggl's "continue last entry" affordance, which copies the previous entry's description as well as its project. Descriptions here are per-task free text (`What are you working on?`); replaying yesterday's text would produce confidently wrong timesheet notes. We seed the project only and leave the description empty.
> **Rejected** — Kimai's global "default activity" admin setting. It is an admin-imposed default, whereas #3750 is about reflecting what the member themselves already did.

## Problem Statement

Reproduced against `c2606970c`:

1. **Start is dead on arrival.** `selectedProjectId` initialises to `null` and nothing seeds it, so Start is disabled on every page load until the user opens the dropdown and picks — even when they are assigned exactly one project.
2. **No explanation.** `disabled={isStarting || !selectedProjectId}` renders a greyed icon-only button whose `aria-label` still reads "Start timer". No tooltip, no hint, no visual link to the picker that would unblock it.
3. **Refresh discards the selection.** The picker is component state; a reload returns it to `null`.
4. **A stop can leave the picker empty** — same root cause as (3), see below.

### Why the picker looks reset after a stop

The issue reports a post-stop reset. `handleStop` does **not** clear `selectedProjectId`; there is no explicit reset anywhere in the file. The real mechanism: while a timer runs, `TimerBar` renders a static project label instead of the picker (`isRunning ? <label> : <picker>`, [TimerBar.tsx:283](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:283)). If the running timer was *adopted from the server* rather than started in this browser session — after a refresh, or started from the dashboard widget, or on another device — `selectedProjectId` was never set. When `isRunning` flips false on stop, the picker re-renders from that still-`null` state and appears "reset".

Consequence for the design: items (3) and (4) are **one defect** — a missing seed from `activeTimer` — not two behaviours needing two rules.

## Blocking Dependency — the `running=true` filter

`useActiveTimesheetTimer` resolves the active timer through
`GET /api/staff/timesheets/time-entries?staffMemberId=…&running=true&pageSize=50`
([useActiveTimesheetTimer.ts:86-90](packages/core/src/modules/staff/lib/timesheets-ui/useActiveTimesheetTimer.ts:86)).

That filter is built by `buildTimeEntryListFilters`. On upstream `develop` it still reads `{ $ne: null }` / bare `null`, which the query engine renders as `started_at != NULL` / `ended_at = NULL` — both UNKNOWN under three-valued logic, matching **zero rows unconditionally**. Upstream therefore never finds a running timer, always reports `activeTimer.projectId === null`, and can neither resume nor seed from one.

The bug landed in `c573bb7bd` (#3717, overnight timers) on 2026-07-02 — the same day #3750 was filed — which is why the issue describes resume as working.

**Fixed on this fork** in `50cf84394` using `{ $exists: true }` / `{ $exists: false }`, the operators that emit `IS NOT NULL` / `IS NULL`. Verified present at [timeEntryListFilters.ts:60-70](packages/core/src/modules/staff/lib/timesheets/timeEntryListFilters.ts:60); `TC-STAFF-030` gates it. `{ $ne: null }` remains **correct** on the MikroORM path (e.g. inside `start_timer`); only the query-engine path was wrong, and that was its sole occurrence.

**Branch base (MUST):** base this work on `fix/2609-timer-stop-stale-list` (`c2606970c`), or on `feat/timesheets-ux-improvements` once [fork PR #2](https://github.com/thegoodcodeio/open-mercato-fork/pull/2) merges. Branching from upstream `develop` inherits the `$ne: null` bug and Phase 2 will appear broken for unrelated reasons.

**Upstream plan:** fork first, stacked on the branch above. The upstream PR is raised later and carries the whole stack, so it necessarily includes the `$exists` fix from `50cf84394` — the fix is already in this branch's ancestry. That PR's description MUST call the `$exists` fix out explicitly as a distinct defect (currently unreported upstream) rather than burying it as an incidental part of a `feature` change.

## Verified Code Facts

Verified against `c2606970c` on 2026-08-09. **Two corrections to the original issue brief are flagged.**

| Location | Fact |
|---|---|
| [TimerBar.tsx:65](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:65) | `useState<string \| null>(null)` — never seeded. Root cause. |
| [TimerBar.tsx:77](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:77) | `activeTimer.projectId` already in scope; used for the running-state label only, never for seeding. |
| [TimerBar.tsx:83](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:83) | `selectedProject = projects.find(...)` — an id absent from `projects` yields an **enabled** Start button with a blank label. |
| [TimerBar.tsx:143](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:143) | `handleStop` never touches `selectedProjectId` — **correction**: there is no explicit post-stop reset. |
| [TimerBar.tsx:384](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:384) | `disabled={isStarting \|\| !selectedProjectId}` on an `IconButton` whose only label is `aria-label="Start timer"`. |
| [page.tsx:891](packages/core/src/modules/staff/backend/staff/timesheets/page.tsx:891) | `<TimerBar projects={allAssignedProjects} …>` — **correction**: the picker lists **all assigned** projects, not grid-visible ones. |
| [page.tsx:366-368](packages/core/src/modules/staff/backend/staff/timesheets/page.tsx:366) | `visibleProjectIdSet` is derived in the page but never passed to `TimerBar`. |
| [page.tsx:409-410](packages/core/src/modules/staff/backend/staff/timesheets/page.tsx:409) | `visibleProjects` → `setProjects(...)` feeds the **grid**, a strictly narrower set than the picker's. |
| [entities.ts:545](packages/core/src/modules/staff/data/entities.ts:545) | `show_in_grid` defaults to `false`. |

### Consequence of the `projects` correction

The issue offers "currently visible grid project (or the sole assigned project when there's only one)" as if these were one ladder. They are different sets, and the picker's is the wider one. The precedence rule below therefore names a set per rung, and every rung is guarded by presence in `projects` — seeding an id the picker cannot display produces an enabled Start button with a blank label, which is worse than today's honest empty state.

## The Two Timer Surfaces

| | `TimerBar` (page) | Time Reporting (dashboard widget) |
|---|---|---|
| Location | Top of `/backend/staff/timesheets`, rendered unconditionally | Optional dashboard card, `defaultEnabled: false` |
| Reach | Every user who opens the timesheets page | Only users who added it, with `dashboards.view` + `staff.timesheets.manage_own` |
| Picker | Custom dropdown + filter box | Native `<select>` |
| Project list | All assigned | All assigned |
| Seeds from running timer | No | No |
| Remembers last project | **No** | **Yes** — `TimeReportingSettings.lastProjectId` |
| Where remembered | — | `dashboard_layouts.layout_json`, per `(user_id, tenant_id, organization_id)` |
| Written when | — | On **successful start only** ([widget.client.tsx:167](packages/core/src/modules/staff/widgets/dashboard/timesheets-time-reporting/widget.client.tsx:167)) |

Both already share `useActiveTimesheetTimer` and `startTimerEntry` — the timer plumbing is common, only the memory is not. The widget's store is injected by the dashboard host via `onSettingsChange`; `TimerBar` is not a dashboard widget and cannot receive it, and `staff` reading `dashboard_layouts` directly would violate the no-cross-module-ORM rule. Hence a new store, owned by `staff`, consumed by both.

## Proposed Solution

### Phase 1 — explain the disabled Start button

Wrap the Start `IconButton` in `SimpleTooltip` whose content is populated **only while the button is disabled**, and distinguish the two blocked states:

- projects exist, none selected → *"Pick a project to start the timer"*
- no projects assigned at all → *"No projects assigned yet — ask an admin to assign you to one"* (picking cannot help; the hint must not send the user to an empty dropdown)

`SimpleTooltip` renders `children` unchanged when `content` is empty ([tooltip.tsx:105-109](packages/ui/src/primitives/tooltip.tsx:105)), so passing `undefined` while enabled is a no-op with no extra DOM.

**Disabled buttons do not emit pointer events**, so the tooltip trigger must wrap a focusable span around the button rather than the button itself. The hint is also wired to the control via `aria-describedby` so it reaches screen readers, which a hover-only tooltip does not.

Phase 1 has no dependency on the `$exists` fix and is independently shippable.

### Phase 2 — seed the picker

A pure resolver decides the seed. First match wins; **every rung is rejected unless the id is present in `projects`**:

| # | Rung | Set read | Rationale |
|---|---|---|---|
| 1 | Running timer's project (`activeTimer.projectId`) | authoritative | Fixes the refresh and post-stop cases — the single defect behind issue items 3 and 4 |
| 2 | Persisted `lastProjectId` | shared preference | What the member actually started last; survives refresh and devices |
| 3 | Sole grid-visible project | `show_in_grid = true` | The member curated this row into their grid; if there is exactly one, intent is unambiguous |
| 4 | Sole assigned project | all assigned | The issue's explicit "only one assigned project" case |
| 5 | `null` | — | Ambiguous. Start stays disabled and the Phase 1 hint explains why |

**Several visible projects → no seed** (rung 3 requires exactly one, and rung 4 then also fails). Guessing among equals would silently mislog time; leaving Start disabled with a hint is honest and costs one click.

Rung 3 needs grid visibility inside `TimerBar`, which it does not currently receive. An **additive optional prop** `visibleProjectIds?: string[]` is passed from `page.tsx`, which already computes `visibleProjectIdSet`. Optional, so no existing caller breaks.

Two correctness constraints on the effect that applies the seed:

- **Wait for the active timer to resolve.** `useActiveTimesheetTimer` loads asynchronously. Seeding before `activeTimer.isLoading === false` would apply rung 2/3/4 and then be overtaken by rung 1. The effect must gate on the timer having settled *and* `projects` having loaded.
- **Never clobber a deliberate pick.** Seed at most once per mount, tracked by a ref, and only while `selectedProjectId === null`.

Writing the memory mirrors the widget's existing rule: persist `lastProjectId` on **successful start only** — not on selection, not on stop. A failed preference write MUST NOT fail the start or flash an error; the timer is already running. Log and move on.

### Phase 3 — unify the dashboard widget

The widget reads the shared preference instead of its own settings. Rather than a data migration that reaches into `dashboard_layouts.layout_json` from a `staff` migration (a cross-module SQL reach for a one-time backfill), the widget performs a **read-through fallback**: if the shared preference is null and `settings.lastProjectId` is set, use the legacy value and write it through to the shared store on the next successful start. Self-healing, zero migration risk, no cross-module SQL.

`TimeReportingSettings.lastProjectId` is a contract surface (a widget settings type). Per `BACKWARD_COMPATIBILITY.md` it is retained, marked `@deprecated`, and dual-written for ≥1 minor version so a rollback does not lose a user's memory, with the removal documented in `UPGRADE_NOTES.md`.

**The widget's seed effect must be redefined, not merely repointed.** Today the widget seeds *synchronously* in the `useState` initialiser (`useState<string | null>(hydrated.lastProjectId)`, [widget.client.tsx:55](packages/core/src/modules/staff/widgets/dashboard/timesheets-time-reporting/widget.client.tsx:55)) because its settings arrive as props. Moving the source to an asynchronously fetched preference introduces exactly the race Phase 2 solves in `TimerBar`: a late-arriving preference overwriting a selection the user already made in the `<select>`.

The widget therefore adopts the same three rules as `TimerBar`:
1. Seed only once the preference query and the project list have both settled.
2. Seed at most once per mount, tracked by a ref.
3. Seed only while the current selection is still `null` — a deliberate pick always wins over a late fetch.

Precedence inside the widget: shared preference → legacy `settings.lastProjectId` (read-through fallback) → `null`. The widget does not implement rungs 1, 3 and 4 of the `TimerBar` ladder; it has no grid context, and its running-timer display already comes from `useActiveTimesheetTimer`. Keeping the two ladders deliberately different is recorded here so a later reader does not "unify" them by accident.

### Design Decisions

| Decision | Rationale |
|---|---|
| Server-side shared preference over `localStorage` | The widget already remembers server-side. A browser-local memory for `TimerBar` would give one member two disagreeing defaults across two surfaces doing the same job, and would not follow them across devices. |
| Persist on successful start, not on selection | Matches the widget's existing rule and Toggl's. An idle mis-click in the dropdown should not become tomorrow's default. |
| Running timer outranks stored preference | The timer is fact; the preference is history. Kimai does the same. Also the only rung that fixes the post-refresh/post-stop defect. |
| No seed when several grid projects are visible | Picking among equals would mislog time silently. A disabled button with a reason is the honest state. |
| Every rung guarded by presence in `projects` | An unmatched id enables Start with a blank label ([TimerBar.tsx:83](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:83)) — strictly worse than no seed. |
| Seeding never PATCHes `show_in_grid` | `show_in_grid = false` by default is deliberate (see § Design Context). Seeding a picker is not consent to re-clutter a curated grid. |
| Preference exposes `updatedAt` but writes last-write-wins | See § Optimistic Locking. |
| Read-through fallback over a backfill migration | Avoids a `staff` migration reading `dashboard_layouts` JSON, and cannot half-fail. |

### Alternatives Considered

| Alternative | Why rejected |
|---|---|
| `localStorage` keyed by staff member | Cheap, but entrenches two divergent memories; starting from the widget would not teach `TimerBar` and vice versa. |
| Reuse the dashboard widget-settings store for `TimerBar` | `onSettingsChange` is injected by the dashboard host into dashboard widgets only. `TimerBar` is a page component; faking a layout entry for it would be an abuse of that mechanism. |
| Seed the *grid's* first project | Order is presentational and shifts as rows are added/removed, so the default would drift for no reason the member can see. |
| Auto-set `show_in_grid` when seeding | Directly contradicts the opt-in design in the 2026-04-08 spec. |
| Tooltip only, no seeding | Explains the wall without removing it; issue item 1 (the manual re-pick) survives. |

## Design Context — `show_in_grid` is deliberate

`show_in_grid` defaulting to `false` is intentional, per [`.ai/specs/implemented/2026-04-08-timesheets-ux-enhancements.md`](.ai/specs/implemented/2026-04-08-timesheets-ux-enhancements.md) § `show_in_grid`: an admin may assign a member to many projects without cluttering their grid; the member opts in via "+ Add row". `staffTimeProjectMemberAssignSchema` deliberately omits `showInGrid`, so only the employee's own endpoint sets it. Projects a member creates from the timesheets page are auto-opted-in ([page.tsx:726](packages/core/src/modules/staff/backend/staff/timesheets/page.tsx:726)).

This spec reads `show_in_grid` (rung 3) and never writes it.

### Adjacent gap — out of scope

Entries load for every assigned project in range ([page.tsx:419-432](packages/core/src/modules/staff/backend/staff/timesheets/page.tsx:419)) but rows render only for visible projects, so time logged against a hidden project renders nowhere. The `show_in_grid` migration backfilled `true` for members that already had entries "so current users don't lose visibility" — the invariant was intended but is enforced only once, at migration time. Not filed upstream. **Out of scope**: this spec never writes `show_in_grid`, so it cannot widen the gap. Worth its own issue.

## User Stories

- **A staff member with one assigned project** wants to land on the timesheets page and press Start immediately, so that logging time does not require re-declaring the only project they have.
- **A staff member returning after a refresh** wants the picker to still show the project their running timer is on, so that stopping and restarting does not require a re-pick.
- **A staff member who starts a timer from the dashboard widget** wants the timesheets page to agree with it, so the two surfaces are one product.
- **A staff member facing a disabled Start button** wants to know why in the moment, so they do not have to guess whether the app is broken or waiting on them.
- **A staff member assigned to twelve projects** wants the app *not* to guess, so they never discover an afternoon logged to the wrong client.

## Architecture

```
page.tsx
  ├─ projects            = allAssignedProjects  ─┐
  ├─ visibleProjectIds   (NEW prop, from show_in_grid) ─┤
  └─ <TimerBar> ─────────────────────────────────┤
        ├─ useActiveTimesheetTimer() → projectId ─┤
        ├─ useTimesheetPreference()   (NEW hook)  ─┤
        │     GET/PUT /api/staff/timesheets/my-preferences
        │                                          ▼
        │                          resolveSeedProjectId()  ← pure, unit-tested
        │                                          │
        └─ selectedProjectId ◄────────────────────┘  (once per mount, only while null)

widget.client.tsx (Phase 3)
  └─ useTimesheetPreference()  ──► same endpoint
        └─ read-through fallback to legacy settings.lastProjectId
```

### Hook contract and cache scoping

`useTimesheetPreference` is a React Query hook, matching `useActiveTimesheetTimer` (which already defines `activeTimesheetTimerQueryKey` over `['staff','timesheets','activeTimer']`).

The endpoint resolves tenant and organization server-side from the request context, so the *response* is scope-dependent while the *request* carries no scope. A scope-blind query key would let an org-A preference be served from cache in org B.

**Key the query by `staffMemberId`:**

```ts
const timesheetPreferenceQueryKey = (staffMemberId: string) =>
  ['staff', 'timesheets', 'preference', staffMemberId] as const
```

This is sufficient rather than merely convenient: `StaffTeamMember` is itself org- and tenant-scoped (`tenantId` and `organizationId` are both required, [entities.ts:75-95](packages/core/src/modules/staff/data/entities.ts:75)), so one user acting in two organizations has **two distinct staff member rows and therefore two distinct ids**. The member id is already an org discriminator; deriving a separate client-side org id — for which there is no cheap client-side source today, cf. the `/api/auth/feature-check` workaround in `useCurrentUserId` — would be redundant.

Consequent requirements:
- The query MUST be `enabled` only once `staffMemberId` is known. No unkeyed or placeholder-keyed fetch.
- The seed effect MUST NOT run against a preference fetched under a different `staffMemberId` than the one currently resolved.
- An in-session organization switch changes the resolved member id, hence the key, hence the cache entry — verified by `TC-STAFF-041`, not assumed.

> **Adjacent gap, out of scope:** `activeTimesheetTimerQueryKey` is a *constant* with no scope in it at all, so the active-timer query has the same theoretical staleness across an org switch. Pre-existing, not introduced here, and not filed upstream. Worth its own issue; this spec does not widen it because the new key is scoped from the start.

The resolver is extracted as a pure function so the whole precedence ladder is unit-testable without a browser:

```ts
export function resolveSeedProjectId(input: {
  runningProjectId: string | null
  lastProjectId: string | null
  visibleProjectIds: string[]
  assignedProjectIds: string[]
}): string | null
```

### Commands & Events

None. Seeding is client-side selection; the preference write is a plain scoped upsert with no domain meaning outside this module. No new command, no new event, nothing for other modules to subscribe to.

## Data Models

### StaffTimesheetPreference (table `staff_timesheet_preferences`)

Follows the module's existing style — explicit FK id columns, no ORM relations, partial unique index — matching `StaffTimeProjectMember` ([entities.ts:520-560](packages/core/src/modules/staff/data/entities.ts:520)).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `defaultRaw: 'gen_random_uuid()'` |
| `tenant_id` | uuid, not null | Scope key |
| `organization_id` | uuid, not null | Scope key |
| `staff_member_id` | uuid, not null | FK id → `staff_team_members.id`, no ORM relation |
| `last_project_id` | uuid, nullable | FK id → `staff_time_projects.id`, no ORM relation |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | Required by `optimistic-lock-editable-entities.test.ts` |
| `deleted_at` | timestamptz, nullable | |

Indexes:
- `staff_timesheet_preferences_unique_idx` — unique on `(organization_id, tenant_id, staff_member_id)` `WHERE deleted_at IS NULL`.

Notes:
- **One row per member per org.** A member acting in two organizations gets two rows and two independent defaults — correct, since projects are org-scoped.
- **No encryption map.** `last_project_id` is an internal UUID FK, not PII, GDPR data, contact info, free text about a person, or a credential. Nothing on this entity qualifies under `packages/core/AGENTS.md` → Encryption. Reads still route through `findOneWithDecryption` for consistency with the module's other reads.
- **`last_project_id` is deliberately not a hard FK constraint**, matching the module's convention. Referential drift (project deleted or unassigned) is handled at read time — see below.

### Stale-reference handling

A stored `last_project_id` can go stale when a project is deleted, archived, or the member's assignment is revoked. Defence in depth:

1. `GET` returns `lastProjectId: null` when the referenced project is no longer an active assignment for that member in that org.
2. `PUT` rejects a project the member is not assigned to (`400`), so a compromised or buggy client cannot park an arbitrary UUID in another member's row.
3. Client-side, rung 2 is guarded by presence in `projects` like every other rung.

## API Contracts

Two precedents apply, and they are cited for different things:

- **Shape** — `/api/auth/sidebar/preferences` ([route.ts](packages/core/src/modules/auth/api/sidebar/preferences/route.ts)): the platform's per-user singleton-preference route. Hand-written route, zod schemas, `OpenApiRouteDoc`, service module, `updatedAt` in the response.
- **Write pipeline** — the sibling `my-projects/[projectId]` route ([route.ts:117-150](packages/core/src/modules/staff/api/timesheets/my-projects/[projectId]/route.ts:117)): same module, same self-service shape, and it runs the mutation-guard registry properly.

Where the two disagree, **`my-projects/[projectId]` wins**. The sidebar route runs no mutation guards and uses a racy load-then-create upsert; neither is a pattern to copy into a new endpoint.

### `GET /api/staff/timesheets/my-preferences`

- Metadata: `{ requireAuth: true, requireFeatures: ['staff.timesheets.manage_own'] }`
- Resolves the caller's own staff member with the existing `getStaffMemberByUserId(em, userId, tenantId, organizationId)` from [`lib/staffMemberResolver.ts`](packages/core/src/modules/staff/lib/staffMemberResolver.ts). There is no `staffMemberId` parameter — the endpoint is *self* only, so it cannot be used to read another member's default.
- Response `200`:
  ```json
  { "lastProjectId": "uuid | null", "updatedAt": "2026-08-09T10:00:00.000Z | null" }
  ```
- `401` unauthenticated · `403` missing feature · `200` with `lastProjectId: null` when no row exists (absence is not an error).

### `PUT /api/staff/timesheets/my-preferences`

- Metadata: `{ requireAuth: true, requireFeatures: ['staff.timesheets.manage_own'] }`
- Request: `{ "lastProjectId": "uuid | null" }` — `staffTimesheetPreferenceUpdateSchema` in `data/validators.ts`:
  ```ts
  export const staffTimesheetPreferenceUpdateSchema = z.object({
    lastProjectId: z.string().uuid().nullable(),
  })
  ```
- Atomically upserts the `(organization_id, tenant_id, staff_member_id)` row — see § Upsert atomicity.
- Response `200`: same shape as `GET`.
- `400` when `lastProjectId` is a project the caller is not actively assigned to · `401` · `403` · `422` when a mutation guard blocks the write.

Both wrapped in `withAtomicFlush`, both scoped by tenant and organization from the request context. Both export `openApi: OpenApiRouteDoc` per `packages/core/AGENTS.md` → API Routes.

### Mutation guards (MANDATORY on `PUT`)

`PUT` is a public mutation endpoint, so it MUST run the mutation-guard registry — the client's own use of it being "best effort" is irrelevant to the route's obligations, and a guard that other modules registered must still see this write. Mirror `my-projects/[projectId]` exactly, using the module-local helpers in [`api/guards.ts`](packages/core/src/modules/staff/api/guards.ts):

```ts
const guardResult = await runStaffMutationGuards(
  container,
  {
    tenantId,
    organizationId,
    userId: auth.sub ?? '',
    resourceKind: 'staff.timesheets.preference',
    resourceId: preferenceId,        // the staff member id when no row exists yet
    operation: 'update',
    requestMethod: req.method,
    requestHeaders: req.headers,
    mutationPayload: parsed.data as unknown as Record<string, unknown>,
  },
  resolveUserFeatures(auth),
)
if (!guardResult.ok) {
  return NextResponse.json(
    guardResult.errorBody ?? { error: 'Operation blocked by guard' },
    { status: guardResult.errorStatus ?? 422 },
  )
}
```

Requirements, all three of which are separately testable:
1. Guards run **before** persistence; a `!ok` result returns `errorStatus` (default `422`) and writes nothing.
2. `guardResult.modifiedPayload` is merged into the values actually persisted — not ignored.
3. `guardResult.afterSuccessCallbacks` run **after** the flush via `runStaffMutationGuardAfterSuccess(...)`, with callback failures caught and logged so a failing callback cannot roll back a committed preference.

`runStaffMutationGuards` internally appends `bridgeLegacyGuard(container)` and returns early when no legacy guard is registered, so no separate bridging call is needed here.

### Upsert atomicity

A load-then-create upsert (what `saveSidebarPreference` does) races on the **first** concurrent write for a member: both requests miss on read, both insert, and the partial unique index turns the loser into a unique-violation 500. Two starts fired in quick succession from two tabs is enough to hit it.

The write MUST therefore be a single atomic statement, not read-then-branch:

- Preferred: MikroORM v7 `em.upsert()` (the repo is on `@mikro-orm/*` `^7.1.5`), which emits `INSERT … ON CONFLICT … DO UPDATE`.
- **Partial-index trap**: the unique index is partial (`WHERE deleted_at IS NULL`). Postgres only infers a partial index when the statement's conflict target repeats the same predicate — `ON CONFLICT (organization_id, tenant_id, staff_member_id) WHERE deleted_at IS NULL DO UPDATE …`. Verify the ORM helper emits that predicate; if it cannot express it, drop to an explicit `ON CONFLICT` statement rather than silently falling back to a non-atomic path.
- Either way, wrap the write so a unique-violation still retries once and re-reads, as a belt-and-braces guard against a soft-deleted row edge case.

Covered by a concurrency test — see `TC-STAFF-040` in § Testing Strategy.

### Service placement and DI

The staff module has **no `services/` directory** — server-side helpers live in `lib/`, and `lib/timesheets/` already holds the timesheet-specific ones. The preference helpers therefore go in `lib/timesheets/timesheetPreferenceService.ts` as a plain functional, data-first module (`loadTimesheetPreference`, `saveTimesheetPreference`), taking `em` and an explicit scope, mirroring `getStaffMemberByUserId`.

No Awilix registration is added. `staff/di.ts` registers only `availabilityAccessResolver`, and only because it is an injection seam for access resolution; a pure data helper is not one. The route obtains `em` from `createRequestContainer()` exactly as the sibling `my-projects/[projectId]` route does. This matches the direct precedent — `sidebarPreferencesService` is likewise an unregistered function module.

**Why a service and not a command.** The recent timer work converted `timer-start`/`timer-stop` to command-bus commands specifically so the CRUD list cache invalidates ([`.ai/specs/2026-07-29-timesheets-timer-stop-stale-list-cache.md`](.ai/specs/2026-07-29-timesheets-timer-stop-stale-list-cache.md)). Neither reason applies here: this preference backs no list route, has no cache to invalidate, emits nothing, and has no meaningful undo — reverting "your default is project A" to a previous default is not an operation a user would ever ask for. The platform's own per-user preference route (`/api/auth/sidebar/preferences`) is service-based for the same reasons, and this follows it.

### Optimistic Locking

The entity carries `updated_at` and `GET` returns `updatedAt`, satisfying the default-ON contract and `optimistic-lock-editable-entities.test.ts`.

The two client writes **deliberately omit** the `x-om-ext-optimistic-lock-expected-updated-at` header and are last-write-wins. Rationale: this preference is written automatically as a side effect of starting a timer, not by a user editing a form. A 409 would surface the shared conflict bar for a write the member never consciously made, over a field whose correct resolution is always "the most recent start wins". The endpoint still *honours* the header when a caller sends one — the server-side guard is wired via `enforceCommandOptimisticLock`, exactly as the sidebar-preferences route does — so a future form-based editor of this preference gets locking for free.

This is not an opt-out of the platform rule: there is no `CrudForm` and no user-editable edit/delete form for this entity, so `optimistic-lock-ui-coverage.test.ts` has no surface to cover. Confirm that test stays green in Phase 2 rather than assuming it.

**Do not confuse this with the server-side mutation guards.** Two different pipelines, one relaxed and one not:

| | Client `useGuardedMutation` | Server mutation-guard registry |
|---|---|---|
| Where | Browser, around the `PUT` call | Inside the `PUT` route handler |
| Status | **Deliberately skipped** — a non-user-initiated side effect that must never fail or block the timer start it follows | **Mandatory** — see § Mutation guards |

Skipping the client wrapper is a UX decision about error surfacing. It grants no exemption to the route, which is a public endpoint reachable by any authenticated caller.

## Internationalization

New keys under the existing `staff.timesheets.my.timer.*` namespace, added to **all four** locale files (`en`, `de`, `es`, `pl`):

| Key | English |
|---|---|
| `staff.timesheets.my.timer.startDisabledNoProject` | Pick a project to start the timer |
| `staff.timesheets.my.timer.startDisabledNoProjects` | No projects assigned yet — ask an admin to assign you to one |

No hardcoded user-facing strings. Existing keys in this file already carry English fallbacks via `t(key, fallback)`; new keys follow that form. Validate with `yarn i18n:check-hardcoded` and `yarn i18n:check-values`.

## UI/UX

Nothing moves and nothing is added to the layout. Two changes are visible:

1. **Hovering or focusing a disabled Start button** shows a tooltip naming the reason. `SimpleTooltip`, `side="top"`, default `delayDuration`.
2. **The picker frequently arrives pre-filled**, showing the project's colour dot and name exactly as it does after a manual pick — the existing `selectedProject` render path is reused unchanged, so a seeded selection is visually indistinguishable from a chosen one. This is deliberate: a seeded project is a real selection the member can override in one click.

### Design System compliance

New code:
- Hint text via `SimpleTooltip` from `@open-mercato/ui/primitives/tooltip` — no bespoke popover, no `title` attribute.
- No status colours introduced; no arbitrary values introduced.
- `aria-describedby` linking the disabled control to its reason; the existing `aria-label` on the icon-only button stays.

**Boy Scout rule** — `TimerBar.tsx` currently violates the DS in the regions this change touches, and those lines MUST be migrated:

| Line | Violation | Target |
|---|---|---|
| [:313](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:313) | raw `<input type="text">` for the dropdown filter | `SearchInput` (or `Input`) — `packages/ui/AGENTS.md` Critical Primitive Rule 1 |
| [:312](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:312) | `min-w-[200px]` arbitrary value | nearest DS scale step (`min-w-52`) |
| [:324](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:324) | `max-h-[200px]` arbitrary value | nearest DS scale step (`max-h-52`) |
| [:362](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:362) | `min-w-[64px]` on the elapsed clock | nearest DS scale step (`min-w-16`) |
| [:296](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:296) vs [:377](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:377) | **Same-row size mismatch** — the picker `Button` is `size="sm"` (h-8) while the Start/Stop `IconButton` is `size="default"` (h-9), both direct children of the same `flex items-center` row | Requires a decision — see below |

**The size mismatch needs a deliberate call in Phase 1, not a silent claim of compliance.** `packages/ui/AGENTS.md` Critical Primitive Rule 3 is explicit that mixing `sm` with `default`/`icon` in one row is a regression. Phase 1 touches the Start button, which puts the mismatch squarely in scope.

Recommendation: **promote the picker to `size="default"`** so the row standardises on h-9, matching the DataTable-toolbar convention the rule cites. Demoting the icon buttons instead would break the shared `FormActionButtons` h-9 standard.

This visibly changes the timer bar's proportions, so it is a design decision rather than a lint fix: raise it with the user during Phase 1 and attach a before/after screenshot to the PR. If the user prefers to keep the compact picker, record that as an accepted, documented exception in this section rather than leaving the spec claiming full DS compliance.

Confirm each replacement against [`.ai/ds-rules.md`](.ai/ds-rules.md) before committing; the suggested steps are nearest-neighbour, not verified pixel-identical.

The description `<input type="text">` at [:262](packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:262) is the same violation but sits outside every region this change touches. Left alone deliberately — the Boy Scout rule covers touched lines, and widening the diff into the timer's primary input would pull QA scope in for no user-visible benefit. Worth its own cleanup issue.

### Frontend Architecture Contract

The full contract (`references/frontend-architecture-contract.md`) is **not required** here: this change touches no `app/**` route, no generated frontend, no shared provider, and no bootstrap scope. Both edited files are already `"use client"` leaves. The relevant subset:

- **Server/Client boundary**: unchanged. `TimerBar` and `widget.client.tsx` were already client components; no server component becomes a client one.
- **`"use client"` ledger**: no new entries. The new `useTimesheetPreference` hook lives beside `useActiveTimesheetTimer` in `lib/timesheets-ui/` and is imported only by existing client files.
- **Client blob**: net additions are one hook, one pure resolver, and one tooltip wrapper — no new dependency, no new bundle.
- **Budgets**: one extra `GET` on timesheets-page mount and on dashboard-widget mount, and one `PUT` per timer start. Runs in parallel with the existing `my-projects` / `time-projects` calls and must not block first paint or gate the grid render.
- **Hydration**: the seed applies in an effect after the timer resolves, so it cannot cause a hydration mismatch. Assert no hydration warnings in the Phase 2 integration run.

## Migration & Compatibility

- **Migration**: one additive `CREATE TABLE staff_timesheet_preferences` plus the partial unique index. No backfill, no changes to existing tables, no downtime, safe to re-run, trivially reversible (`DROP TABLE`).
- Generate with `yarn db:generate`; review the SQL and `migrations/.snapshot-open-mercato.json`. If the generator emits unrelated migrations, delete them and keep only this one, per the coding-agent exception in the root `AGENTS.md`. Do **not** run `yarn db:migrate` to quiet the generator.
- **Contract surfaces touched**: `TimeReportingSettings.lastProjectId` (a type). Retained, `@deprecated`, dual-written for ≥1 minor version, removal documented in `UPGRADE_NOTES.md`. `TimerBar`'s new `visibleProjectIds` prop is optional — additive-only.
- **Rollback**: reverting Phase 3 leaves the widget reading `settings.lastProjectId`, still populated by the dual write. Reverting Phase 2 leaves an unused table. No data loss at any step.

## Implementation Plan

### Phase 1 — Explain the disabled Start button
1. Add the two i18n keys to `en`/`de`/`es`/`pl`.
2. Wrap the Start `IconButton` in `SimpleTooltip`, passing content only while disabled and selecting between the two reasons on `projects.length === 0`.
3. Make the trigger hover/focus-reachable despite the disabled button, and wire `aria-describedby`.
4. Migrate the touched DS violations listed above.
5. Tests: `TC-STAFF-032`.

*Shippable alone. No dependency on Phase 2 or the `$exists` fix.*

### Phase 2 — Shared preference and picker seeding
1. Add `StaffTimesheetPreference` to `packages/core/src/modules/staff/data/entities.ts`; `yarn db:generate`; review SQL + snapshot.
2. Add `staffTimesheetPreferenceUpdateSchema` to `data/validators.ts`.
3. Add `lib/timesheets/timesheetPreferenceService.ts` (load / upsert, org+tenant scoped, assignment-validated).
4. Add `api/timesheets/my-preferences/route.ts` — `GET`/`PUT`, metadata, zod, `openApi`, `withAtomicFlush`, `enforceCommandOptimisticLock`, **and the mandatory mutation-guard pipeline** (`runStaffMutationGuards` → merge `modifiedPayload` → flush → `runStaffMutationGuardAfterSuccess`), mirroring `my-projects/[projectId]`.
4b. Implement the write as an **atomic upsert** with a conflict target matching the partial unique index; verify the emitted SQL carries the `WHERE deleted_at IS NULL` predicate.
5. Add the pure `resolveSeedProjectId` resolver + unit tests covering all five rungs and the not-in-`projects` guard.
6. Add `useTimesheetPreference` beside `useActiveTimesheetTimer`.
7. Pass `visibleProjectIds` from `page.tsx` into `TimerBar` (optional prop).
8. Apply the seed in `TimerBar`: gated on the timer having settled and projects loaded, once per mount, only while `selectedProjectId === null`.
9. Persist `lastProjectId` on successful start; failures logged, never surfaced, never failing the start.
10. `yarn generate`.
11. Tests: `TC-STAFF-033`, `034`, `035`, `036`, `040`, `041`, plus the route-level guard tests.

### Phase 3 — Unify the dashboard widget
1. Point `widget.client.tsx` at `useTimesheetPreference`.
2. Replace the synchronous `useState(hydrated.lastProjectId)` seed with the async-safe effect defined in § Phase 3 (settled-then-once-then-only-if-null).
3. Read-through fallback to `settings.lastProjectId` when the shared preference is null.
4. Dual-write both stores on successful start; mark `TimeReportingSettings.lastProjectId` `@deprecated`.
5. Document the deprecation in `UPGRADE_NOTES.md`.
6. Update the widget's existing `__tests__/widget.client.test.tsx` for the new source of truth, including the seed-race case.
7. Tests: `TC-STAFF-037`, `038`, `039`.

### File Manifest

| File | Action | Purpose |
|---|---|---|
| `packages/core/src/modules/staff/data/entities.ts` | Modify | `StaffTimesheetPreference` |
| `packages/core/src/modules/staff/data/validators.ts` | Modify | `staffTimesheetPreferenceUpdateSchema` |
| `packages/core/src/modules/staff/migrations/*` | Create | Additive table + partial unique index |
| `packages/core/src/modules/staff/lib/timesheets/timesheetPreferenceService.ts` | Create | Scoped load/upsert with assignment validation |
| `packages/core/src/modules/staff/api/timesheets/my-preferences/route.ts` | Create | `GET`/`PUT` self-scoped preference |
| `packages/core/src/modules/staff/lib/timesheets-ui/resolveSeedProjectId.ts` | Create | Pure precedence resolver |
| `packages/core/src/modules/staff/lib/timesheets-ui/useTimesheetPreference.ts` | Create | Client hook over the endpoint |
| `packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx` | Modify | Tooltip, seeding, persist-on-start, DS cleanup |
| `packages/core/src/modules/staff/backend/staff/timesheets/page.tsx` | Modify | Pass `visibleProjectIds` |
| `packages/core/src/modules/staff/widgets/dashboard/timesheets-time-reporting/widget.client.tsx` | Modify | Phase 3 — shared preference + fallback |
| `packages/core/src/modules/staff/widgets/dashboard/timesheets-time-reporting/config.ts` | Modify | Phase 3 — `@deprecated` on `lastProjectId` |
| `packages/core/src/modules/staff/i18n/{en,de,es,pl}.json` | Modify | Two new keys |
| `packages/core/src/modules/staff/__integration__/TC-STAFF-0{32..41}*.spec.ts` | Create | Integration coverage |
| `packages/core/src/modules/staff/api/timesheets/my-preferences/__tests__/` | Create | Route-level guard + upsert-concurrency tests |
| `UPGRADE_NOTES.md` | Modify | Phase 3 deprecation |

### Testing Strategy

**Unit** — `resolveSeedProjectId`: each rung in isolation; rung 1 beating rungs 2–4; two visible projects yielding `null`; an id absent from `assignedProjectIds` being rejected at every rung; empty inputs.

**Integration** (Playwright, `packages/core/src/modules/staff/__integration__/`, ids continue from `TC-STAFF-031`). Per `.ai/qa/AGENTS.md` each test creates its own staff member, projects and assignments in setup and cleans up in `finally` — no reliance on seeded or demo data.

| ID | Covers |
|---|---|
| `TC-STAFF-032` | Disabled Start shows the reason; picking clears it and enables Start; the no-projects variant shows the other message |
| `TC-STAFF-033` | Seed from running timer — start, reload, picker shows the project; stop, picker keeps it and Start is immediately usable *(the #3750 refresh + post-stop complaints)* |
| `TC-STAFF-034` | Last-used persistence — start+stop project A, reload, picker preselects A |
| `TC-STAFF-035` | Sole assigned project — member lands with Start already enabled |
| `TC-STAFF-036` | Ambiguity — two grid-visible projects produce no seed, Start disabled with the hint |
| `TC-STAFF-037` | Cross-surface, dashboard → `TimerBar` — last used set from the widget preselects in the timer bar |
| `TC-STAFF-038` | Cross-surface, `TimerBar` → dashboard — the reverse direction, proving the unification is bidirectional and not a one-way read |
| `TC-STAFF-039` | Legacy fallback hydration — a user whose only memory is `settings.lastProjectId` (no shared row) still gets it seeded, and the next successful start writes it through to the shared store |
| `TC-STAFF-040` | Upsert concurrency — two simultaneous first writes for the same member yield one row and two `200`s, never a unique-violation `500` |
| `TC-STAFF-041` | Scope switch — switching organization in-session does not serve org A's preference in org B |

Route-level guard coverage (unit or route tests, not necessarily Playwright): a registered guard returning `!ok` blocks the `PUT` and persists nothing; `modifiedPayload` is applied to what is written; `afterSuccessCallbacks` fire after the flush, and a throwing callback is caught and logged without rolling back the committed row.

Widget seed-race coverage: a deliberate `<select>` change made *before* the preference query resolves is not overwritten when it lands.

`TC-STAFF-033` is the regression gate for the `$exists` dependency: it fails on any base lacking `50cf84394`, which is the intended signal.

## Risks & Impact Review

#### Accidental start on a stale default
- **Scenario**: Seeding makes Start one click. A member who previously had to pick consciously now presses Start on a default they did not read — from last week's project, or a project seeded by rung 3 they had forgotten was in their grid — and logs an afternoon to the wrong client. Detected late, at approval or invoicing.
- **Severity**: High — this is the failure mode the feature creates, and time data feeds billing.
- **Affected area**: `staff.timesheets` time entries; downstream reporting and any billing built on it.
- **Mitigation**: Seed only unambiguous cases (rungs 3–4 require exactly one candidate; several visible projects seed nothing). Rung 2 is the member's own last *started* project, not a mis-click. The seeded project renders with its colour dot and name in the same prominent affordance as a manual pick, directly left of Start. Entries remain editable in the grid.
- **Residual risk**: A determined skim-and-click can still start on the wrong project. Accepted — it is the explicit intent of #3750, matches Toggl/Kimai behaviour, and the alternative (never defaulting) is the reported bug.

#### Seeding a project the member may no longer use
- **Scenario**: A stored `last_project_id` outlives the assignment — project archived, deleted, or the member unassigned. Seeding it would show a project they cannot legitimately book to, or a name from a project since moved.
- **Severity**: Medium.
- **Affected area**: `TimerBar` and the dashboard widget picker.
- **Mitigation**: Three independent guards — `GET` returns `null` for a non-active assignment; `PUT` rejects unassigned projects; the client rejects any rung whose id is absent from `projects`. A start against a revoked assignment is rejected by `start_timer` regardless.
- **Residual risk**: A brief window where a revoked assignment is still cached client-side; the start then fails with the existing error. Acceptable.

#### Cross-tenant / cross-organization leakage of a project reference
- **Scenario**: A member acting in two organizations sees org A's default while working in org B, exposing an org A project name.
- **Severity**: High if realised — this is a tenant-isolation boundary.
- **Affected area**: The new endpoint and entity.
- **Mitigation**: `organization_id` and `tenant_id` are part of the unique key and of every read and write; scope is resolved from the request context, never from client input. `GET`/`PUT` are self-scoped — no `staffMemberId` parameter exists, so one member cannot address another's row. `PUT` additionally validates the project is assigned to the caller *in that org*.
- **Residual risk**: None beyond the module's existing scoping, which this endpoint reuses rather than reimplements. `TC-STAFF-03x` fixtures should include a second-organization member to keep the boundary asserted.

#### Preference write fails after a successful start
- **Scenario**: The timer starts, the `PUT` fails (network, 500). Naively awaited and unguarded, this would flash an error for an operation that succeeded.
- **Severity**: Low.
- **Affected area**: `TimerBar`, dashboard widget.
- **Mitigation**: The write is explicitly non-blocking and non-surfacing — logged via `createLogger`, never flashed, never failing the start. The start's own success/failure path is untouched.
- **Residual risk**: The memory silently misses one update; the next successful start corrects it.

#### Seed races the active-timer lookup
- **Scenario**: `useActiveTimesheetTimer` resolves after mount. A seed applied before it settles picks rung 2/3/4, then rung 1 arrives — either the picker visibly flips, or the wrong project sticks.
- **Severity**: Medium — it would reintroduce the exact confusion the issue reports.
- **Affected area**: `TimerBar` seeding effect.
- **Mitigation**: The effect gates on the timer having settled *and* projects having loaded, seeds once per mount via a ref, and only while `selectedProjectId === null`. The resolver is pure and unit-tested across the ordering.
- **Residual risk**: On a very slow timer lookup the picker stays empty slightly longer than today. Strictly better than seeding wrongly.

#### Phase 3 divergence during the deprecation window
- **Scenario**: Between Phase 3 and the removal of `TimeReportingSettings.lastProjectId`, a rollback or a stale client leaves the two stores disagreeing.
- **Severity**: Low.
- **Affected area**: Dashboard widget default.
- **Mitigation**: Dual write for ≥1 minor version; the shared preference always wins on read; the legacy value is a fallback only when the shared one is null.
- **Residual risk**: A rolled-back deployment may serve a slightly older default for one start. Self-heals on the next successful start.

#### Unique-violation 500 on concurrent first write
- **Scenario**: Two timer starts fire near-simultaneously for a member with no preference row yet (two tabs, or a double-click). A load-then-create upsert has both requests miss on read and both insert; the partial unique index rejects the loser with a unique violation surfacing as a 500.
- **Severity**: Medium — the timer start itself already succeeded, so no time data is lost, but a 500 on a public endpoint is a real defect and would appear in logs and error budgets.
- **Affected area**: `PUT /api/staff/timesheets/my-preferences`.
- **Mitigation**: Single-statement atomic upsert with a conflict target matching the partial index predicate, plus a retry-once guard on unique violation. Explicitly **not** copied from `saveSidebarPreference`, which has this race.
- **Residual risk**: A pathological retry storm is bounded at one retry, after which the failure is logged and swallowed by the non-blocking client path. `TC-STAFF-040` asserts the happy path.

#### Cross-organization preference served from client cache
- **Scenario**: A member switches organization in-session. A scope-blind React Query key serves org A's cached preference in org B, seeding a project from another organization.
- **Severity**: High if realised — it would surface an out-of-scope project name in the picker.
- **Affected area**: `useTimesheetPreference`, and by extension the seeded picker in both surfaces.
- **Mitigation**: The query key includes `staffMemberId`, which is inherently org-discriminating because `StaffTeamMember` is org-scoped — a switch yields a different member id and therefore a different cache entry. The query is disabled until the member id is known, and the seed effect ignores a preference fetched under a different member id. Server-side the endpoint re-resolves scope from the request context on every call, so a stale client key cannot cause a stale *server* read.
- **Residual risk**: Bounded by the correctness of the member-id resolution, which is pre-existing shared machinery. `TC-STAFF-041` asserts the switch. The unscoped `activeTimesheetTimerQueryKey` remains as a pre-existing adjacent gap, unchanged by this work.

#### Cascading failures and module isolation
- No events are emitted and no other module reads this entity, so there is no downstream subscriber to fail. No cross-module ORM relation is introduced: `last_project_id` and `staff_member_id` are plain FK id columns, and both referenced entities live in `staff` anyway. The dashboard widget reaches the store over HTTP like any other client, so `staff` never touches `dashboard_layouts`. Storage growth is one small row per member per organization, written at most once per timer start.

## Final Compliance Report — 2026-08-09

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)
- `.ai/specs/AGENTS.md`
- `packages/ui/AGENTS.md`
- `packages/core/AGENTS.md`
- `.ai/qa/AGENTS.md`
- `.ai/skills/om-backend-ui-design/SKILL.md`, `.ai/ds-rules.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| root | No direct ORM relationships between modules | Compliant | Plain FK id columns; both referents are in `staff` |
| root | Filter by `organization_id` for scoped entities | Compliant | Part of the unique key and every read/write |
| root | Never expose cross-tenant data | Compliant | Self-scoped endpoint, no `staffMemberId` parameter |
| root | Validate inputs with zod in `data/validators.ts` | Compliant | `staffTimesheetPreferenceUpdateSchema` |
| root | Derive TS types from zod via `z.infer` | Compliant | Follows the module's existing export style |
| root | Tables plural snake_case, entities singular | Compliant | `staff_timesheet_preferences` / `StaffTimesheetPreference` |
| root | Common columns present | Compliant | `id`, `created_at`, `updated_at`, `deleted_at`, `organization_id`, `tenant_id` |
| root | Optimistic locking default ON for new user-editable entities | Compliant | `updated_at` present, `updatedAt` returned, server guard wired; client writes are last-write-wins by documented decision (§ Optimistic Locking) |
| root | Encryption maps for sensitive columns | N/A — documented | No PII/GDPR/credential column on this entity; rationale recorded in § Data Models |
| root | Migration workflow (`db:generate`, review snapshot, never `db:migrate` to quiet it) | Compliant | Phase 2 step 1 |
| root | `yarn generate` after auto-discovery files change | Compliant | Phase 2 step 10 |
| root | Never hard-code user-facing strings | Compliant | Two keys × four locales |
| root | Use `apiCall`, never raw `fetch` | Compliant | New hook uses `apiCall` |
| root | Non-`CrudForm` **client** writes wrapped in `useGuardedMutation` | Deviation — documented | The timer start already is; the preference `PUT` is a non-user-initiated side effect that must not fail the start, so it is deliberately outside the client wrapper |
| `packages/core` | Custom write routes MUST run the **server** mutation-guard registry | Compliant | `runStaffMutationGuards` + `modifiedPayload` + `runStaffMutationGuardAfterSuccess` on `PUT`; see § Mutation guards. Distinct from the row above — see the table in § Optimistic Locking |
| `packages/core` | Concurrent writes must not corrupt or 500 | Compliant | Atomic upsert with a partial-index-aware conflict target; `TC-STAFF-040` |
| `packages/ui` | Same-row buttons share `size` | Decision required in Phase 1 | Picker `sm` vs Start `default`; recommendation and escalation recorded in § Design System compliance |
| root | No `any` | Compliant | Resolver and hook are fully typed |
| root | `pageSize` ≤ 100 | N/A | No list endpoint added |
| `packages/core` | API routes export `openApi` | Compliant | Both methods |
| `packages/core` | Declarative feature guards, not `requireRoles` | Compliant | `requireFeatures: ['staff.timesheets.manage_own']` |
| `packages/ui` | No raw `<input>` / `<button>` | Compliant after Boy Scout migration of touched lines; the untouched description input is explicitly deferred with rationale |
| `packages/ui` | No arbitrary values | Compliant after the four listed replacements |
| `packages/ui` | Reuse primitives before building new | Compliant | `SimpleTooltip`, `SearchInput` |
| `packages/ui` | No hardcoded status colours | Compliant | None introduced |
| `BACKWARD_COMPATIBILITY.md` | Deprecation protocol on contract surfaces | Compliant | `TimeReportingSettings.lastProjectId` — retained, `@deprecated`, dual-written ≥1 minor, `UPGRADE_NOTES.md` |
| `.ai/qa` | Integration coverage ships in the same change | Compliant | `TC-STAFF-032`…`037` in their phases |
| `.ai/qa` | Self-contained fixtures, cleanup in `finally` | Compliant | § Testing Strategy |
| `.ai/specs` | Naming `{YYYY-MM-DD}-{kebab-case}.md`, no `SPEC-*` prefix | Compliant | This file |
| checklist §2 | DI wiring specified | Compliant | Plain functional module, no registration — rationale in § Service placement and DI |
| checklist §3 | Injection vectors parameterized | Compliant | MikroORM `em` + `findOneWithDecryption`; no raw SQL, no string interpolation |
| checklist §3 | XSS on user-rendered content | N/A | Only a UUID and existing project names cross the boundary; both render through React text nodes, no raw HTML |
| checklist §3 | Encoding for URLs / JSON | Compliant | No dynamic path segments; `PUT` body is JSON validated by zod |
| checklist §3 | Secrets excluded from logs and responses | Compliant | The failed-write log records the error only; the entity holds no secret |
| checklist §4 | Singular entity naming | Compliant | `StaffTimesheetPreference` |
| checklist §4 | Undo contract | N/A — documented | No command; a preference upsert has no meaningful undo (§ Service placement and DI) |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Data models match API contracts | Pass | `lastProjectId` + `updatedAt` in both |
| API contracts match UI/UX section | Pass | One `GET` on mount, one `PUT` per successful start |
| Risks cover all write operations | Pass | The `PUT` is the only new write; failure, staleness and isolation each have entries |
| Commands defined for all mutations | Pass — N/A | No command introduced; rationale in § Architecture |
| Cache strategy covers all read APIs | Pass — N/A | Single-row self-scoped read, written by its only reader; caching would add invalidation risk for no gain |
| Precedence rule matches the resolver signature | Pass | Five rungs, four inputs, all guarded by `assignedProjectIds` |
| Phasing is independently deployable | Pass | Phase 1 standalone; Phase 3 depends on Phase 2 only |

### Non-Compliant Items

None blocking. Two deliberate deviations, both documented above with rationale, both narrowly scoped to the **client**:
- **Preference `PUT` not wrapped in `useGuardedMutation`** — it is a non-user-initiated side effect that must never fail or block the timer start it follows. This does **not** extend to the route, which runs the server-side mutation-guard registry unconditionally.
- **Client writes omit the optimistic-lock header** — last-write-wins is the correct semantic for an automatically written preference; the server-side guard is still wired for any future caller that sends the header.

One decision deferred to implementation, deliberately not pre-empted here:
- **Picker vs Start button size** — Phase 1 must either promote the picker to `size="default"` or record an accepted exception. Not resolvable without seeing the rendered result.

### Verdict

**Fully compliant — approved for implementation**, subject to the branch-base requirement in § Blocking Dependency and the Phase 1 size decision above.

## PR & Labelling

`feature` · one `priority-*` · one `risk-*` · `needs-qa` · `screenshots`.

This touches `.tsx` under `packages/core/src/modules/staff/`, adds a database table, and adds an API surface, so it does **not** qualify for the automated-verification `skip-qa` exemption on any of the three counts. Screenshots should cover the tooltip on the disabled Start button and a pre-filled picker on load.

## Changelog

### 2026-08-09
- Initial specification. Open Questions Q1–Q4 resolved: both remedies in one spec across three phases; shared server-side preference entity (replacing an initial `localStorage` proposal after the dashboard widget's existing server-side `lastProjectId` was found); seeding prefers grid-visible but never seeds outside the picker; fork-first on a stacked branch with a later upstream PR carrying the `$exists` fix.
- Code pointers verified against `c2606970c`. Two corrections to the issue brief recorded: `TimerBar` is fed `allAssignedProjects`, not `visibleProjects`; and there is no explicit post-stop reset — the post-refresh and post-stop complaints share one root cause.

### Review — 2026-08-09
- **Reviewer**: Agent (self-review; the checklist's §1 fresh-context subagent delegation was **not** performed — this session's operating rules bar spawning subagents unless the user asks. The scope-cohesion item below is therefore a self-assessment and should be re-run by a second reader before implementation.)
- **Security**: Passed — self-scoped endpoint with no member parameter, org+tenant in the unique key and every query, zod-validated input, assignment validated server-side, no raw SQL, no PII on the entity.
- **Performance**: Passed — one extra `GET` per surface mount running in parallel with existing loads, one `PUT` per timer start, one small row per member per org.
- **Cache**: Passed (N/A) — single-row self-scoped read written by its only reader; caching would add invalidation risk for no gain. Recorded in the consistency check.
- **Commands**: Passed (N/A) — no command introduced; justified against both the `sidebarPreferences` precedent and the reason the timer commands exist.
- **Risks**: Passed — six entries. The one that matters is *Accidental start on a stale default*: the feature's own creation, High severity because time data feeds billing, mitigated by refusing to seed ambiguous cases and accepted as residual because it is the explicit intent of #3750.
- **Scope cohesion**: Phase 1 is independently deployable and Phases 2–3 are not independent of each other, so this is one capability with a staged rollout rather than a bundle. Phase 1 could be split into its own PR without harm if review prefers; that option is recorded rather than taken.
- **Verdict**: Approved — ready for implementation on the branch base named in § Blocking Dependency.

### Review — 2026-08-09 (second pass, external reviewer)
- **Reviewer**: Human review of the first draft. Four findings, all verified against the codebase and all accepted. No finding was rejected.
- **High — `PUT` bypassed the mutation-guard pipeline.** Upheld. The first draft modelled the route wholly on `/api/auth/sidebar/preferences`, which runs no guards; the correct in-module precedent is the sibling `my-projects/[projectId]`, which runs `runStaffMutationGuards` / `modifiedPayload` / `runStaffMutationGuardAfterSuccess` properly. The draft also conflated the *client* `useGuardedMutation` deviation with the *server* registry, letting a UX decision read as a route exemption. Added § Mutation guards, the two-pipeline table in § Optimistic Locking, route-level guard tests, and split compliance rows. (The registry helper is named `runStaffMutationGuards` in this module, not `runRouteMutationGuards`.)
- **Medium — upsert race.** Upheld. `saveSidebarPreference` is precisely the racy load-then-create the finding describes, so the draft inherited the defect by citing it. Added § Upsert atomicity requiring a single atomic statement, plus the partial-index inference trap (`ON CONFLICT … WHERE deleted_at IS NULL`) that would otherwise turn a nominal upsert into a silent non-atomic fallback, plus `TC-STAFF-040`.
- **Medium — query cache scoping.** Upheld; the repo does use React Query. Added the hook contract keyed by `staffMemberId`, which is sufficient because `StaffTeamMember` is org-scoped so the id already discriminates organization — no client-side org id needed, and there is no cheap source for one. Added `TC-STAFF-041` and noted the pre-existing unscoped `activeTimesheetTimerQueryKey` as an adjacent gap.
- **Medium — Phase 3 coverage.** Upheld. Added the reverse direction (`TC-STAFF-038`), legacy fallback hydration (`TC-STAFF-039`), and — the substantive gap — a definition of the widget's seed effect, which today seeds synchronously from props and would acquire `TimerBar`'s async race on being repointed at a fetched preference.
- **Low — same-row button size.** Upheld. Picker is `size="sm"`, Start `IconButton` is `size="default"`, same flex row, contrary to `packages/ui/AGENTS.md` Critical Primitive Rule 3. The draft's claim of DS compliance was overstated. Now an explicit Phase 1 decision with a recommendation (promote the picker to `default`) and an escalation path, rather than a silent fix.
- **Verdict**: Approved with the above folded in. Test range grows from `TC-STAFF-032…037` to `032…041` plus route-level guard tests.
