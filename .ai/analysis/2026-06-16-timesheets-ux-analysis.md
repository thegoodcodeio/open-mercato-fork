# Timesheets UX Analysis

Date: 2026-06-16
Branch context: current working branch in `open-mercato`

## Scope

This note captures a focused UX and integration-test review of the timesheets feature:

- `My Timesheets` page at `/backend/staff/timesheets`
- `Projects` page at `/backend/staff/timesheets/projects`
- Supporting timer and list-view interactions

## Test Summary

Focused Playwright coverage on this branch produced two different classes of signal.

### Passing product-level coverage

The following timesheets integration tests passed earlier in the session:

- `TC-STAFF-010` time entry CRUD API
- `TC-STAFF-011` timer start/stop and segments API
- `TC-STAFF-013` bulk save API
- `TC-STAFF-024` time-entry date filter regression checks

This suggests the core timesheets backend flows are mostly healthy.

### Failing UX-facing coverage

Two UI smoke tests exposed real page-level UX issues:

- `TC-STAFF-020` My Timesheets Grid Loads
- `TC-STAFF-021` Projects List Loads

Observed failures:

- `/backend/staff/timesheets` remained on `Loading timesheets...` long enough for the test to time out.
- `/backend/staff/timesheets/projects` rendered shell chrome but never exposed the primary `Add Project` action within the timeout window.

### Resume-session test caveat

During the resumed investigation, additional non-UI tests (`TC-STAFF-023`, `TC-STAFF-024`) failed with a local environment connectivity error:

- `connect EPERM 127.0.0.1:3000`

Those failures were environment-related and did not add new product-level evidence.

## Key Findings

### 1. My Timesheets uses an all-or-nothing client boot

The main load sequence is in:

- `packages/core/src/modules/staff/backend/staff/timesheets/page.tsx`

Important code points:

- feature check: lines 180-198
- primary data load starts: lines 256-351
- full-page loading gate: lines 647-649

The page waits on:

1. `GET /api/staff/team-members/self`
2. `GET /api/staff/timesheets/my-projects`
3. `GET /api/staff/timesheets/time-projects`
4. `GET /api/staff/timesheets/time-entries`

If any of those requests are slow or hang, the entire page remains blocked behind the full-page spinner. There is no partial rendering path for the shell, project rows, summary cards, or list view.

UX impact:

- the page feels fragile
- the user cannot distinguish between "still loading", "degraded but usable", and "broken"
- a slow dependency blocks the entire workflow

### 2. Shared API calls have no timeout boundary

Shared helper:

- `packages/ui/src/backend/utils/apiCall.ts`

Important code points:

- `apiCall`: lines 42-76
- `readApiResultOrThrow`: lines 100-123

These helpers do not apply a timeout or `AbortController`. If a request never settles, the UI has no built-in escape hatch. This amplifies the all-or-nothing loading problem on timesheets pages.

UX impact:

- indefinite loading states
- no user-facing recovery path
- hard-to-diagnose "stuck" pages

### 3. Projects page couples permissions to KPI data

Projects page:

- `packages/core/src/modules/staff/backend/staff/timesheets/projects/page.tsx`

Important code points:

- PM role derived from KPI payload: line 307
- KPI load: lines 346-363
- project list load: lines 365-411
- `canManage = isPmRole`: line 614
- `Add Project` action rendered only when `canManage`: lines 719-724

The page currently infers whether the user can manage projects from the KPI response shape instead of from stable auth/feature state.

Consequences:

- if KPI fetch is slow, permission-gated UI appears late
- if KPI fetch fails, PM-only actions can disappear entirely
- the primary action is not stable during page boot

This is the strongest explanation for the `TC-STAFF-021` behavior.

### 4. Projects first-load behavior can be briefly wrong for PMs

Also in the Projects page:

- `mineFromTab`: line 344
- `loadProjects`: lines 365-411

Before KPIs resolve, `isPmRole` is falsey, which means the page may initially behave like a collaborator view and request `mine=1`. Once KPIs resolve, the page behavior can change.

UX impact:

- flickery or inconsistent first paint
- risk of "wrong initial dataset, corrected later"
- harder-to-understand tabs and filters

### 5. Saving timesheets is too heavy for the task

My Timesheets save flow:

- `packages/core/src/modules/staff/backend/staff/timesheets/page.tsx`
- confirmation dialog in lines 407-413

Every save requires a confirmation dialog, even for routine cell edits.

UX impact:

- too much friction for spreadsheet-style entry
- repetitive confirmation fatigue
- slower flow for power users entering many daily values

### 6. Month/week switching loses user context

View-mode switching:

- `packages/core/src/modules/staff/backend/staff/timesheets/page.tsx`
- lines 518-532

When switching from monthly back to weekly, the page jumps to the week containing the 15th of the month rather than preserving the currently focused date context.

UX impact:

- navigation feels arbitrary
- users can lose the week they were mentally anchored to

### 7. Timer editing is constrained in a way that hurts correction flow

Timer bar:

- `packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx`

Important code points:

- active timer rehydration: lines 85-112
- timer start: lines 137-178
- timer stop: lines 180-203
- description input becomes read-only while running: lines 207-216

While a timer is running:

- the description cannot be edited
- stopping the timer clears the description immediately

UX impact:

- harder to recover from vague or mistaken descriptions
- unnecessary interruption for real-world time tracking

### 8. List-view note editing fails silently

List view inline note editing:

- `packages/core/src/modules/staff/lib/timesheets-ui/ListView.tsx`

Important code points:

- inline save callback: lines 98-118

The inline description update swallows failures and shows no feedback.

UX impact:

- users may assume edits were saved when they were not
- silent failure is especially risky for note/detail entry

## Prioritized UX Improvements

### P1. Decouple project-management UI from KPI loading

Recommended change:

- determine `canManage` from auth/feature-check state, not from `kpis?.role`
- treat KPIs as enhancement data, not as the source of action visibility

Expected result:

- `Add Project` becomes stable
- PM tabs and row actions stop flickering
- `TC-STAFF-021` becomes much less fragile

### P1. Replace the full-page spinner with progressive rendering

Recommended change:

- render the page shell immediately
- load self/profile state first
- then load assignments, projects, and entries independently
- show skeletons or section-level loading where needed

Expected result:

- faster perceived performance
- fewer "blank screen" failures
- `TC-STAFF-020` more closely reflects actual usability

### P1. Add delayed-loading and retry states

Recommended change:

- after a short threshold, switch from generic loading to a delayed-loading message
- expose retry actions for failed sections
- log which subsection failed instead of collapsing all failures into one generic flash

Expected result:

- better user trust
- easier diagnosis
- less confusion when one dependency is degraded

### P2. Remove unconditional save confirmation for routine edits

Recommended change:

- save directly, or
- confirm only for destructive/high-risk cases, or
- autosave after blur / short idle interval with explicit success/error feedback

Expected result:

- faster entry flow
- fewer repetitive interruptions

### P2. Preserve navigation context across monthly and weekly views

Recommended change:

- keep track of the currently focused date
- when switching views, anchor to that date instead of mid-month

Expected result:

- more intuitive navigation
- less context loss

### P2. Improve timer correction flow

Recommended change:

- allow editing the active timer description while running, or
- preserve the last entered description after stop until a new timer starts

Expected result:

- easier recovery from human mistakes
- better match for real work logging behavior

### P2. Surface inline-save failures in list view

Recommended change:

- use the guarded mutation or a visible flash/toast/error state for inline note edits

Expected result:

- users know when note updates fail
- lower risk of silent data loss perception

## Recommended Implementation Order

1. Fix Projects permission coupling and stabilize the `Add Project` action.
2. Refactor My Timesheets loading to progressive rendering with bounded loading states.
3. Remove unconditional save confirmation for normal entry.
4. Preserve date context when switching views.
5. Improve timer and inline-note editing feedback.

## Suggested Follow-up Tests

After implementation, re-run or strengthen:

- `TC-STAFF-020`
- `TC-STAFF-021`

Recommended additions:

- a UI test asserting the page shell renders before entries finish loading
- a UI test asserting PM actions stay visible even if KPI request is delayed
- a UX test around switching monthly -> weekly while preserving the focused date
- a timer test covering editing or preserving description state

## Bottom Line

The timesheets backend appears mostly sound, but the UX layer is too dependent on late client-side data to become usable. The biggest wins are:

- stable permission-driven actions
- progressive loading instead of global blocking
- less friction in the core time-entry workflow
