# Timesheets UX Improvements - Handoff

Date: 2026-07-27
Branch: `feat/timesheets-ux-improvements` (based on `fork/develop` @ `3ab996cab`)
Companion analysis: [`2026-06-16-timesheets-ux-analysis.md`](./2026-06-16-timesheets-ux-analysis.md)

## What this branch is

A set of UX improvements to the staff timesheets feature, originally prototyped against an
older base (`29f01e2c4`) and re-derived onto the current fork `develop`, which had advanced
~1372 commits and independently touched the same files. This document records exactly what
was ported, what was intentionally dropped (because upstream already solved it), how conflicts
with the fork were resolved, and what still needs doing.

The improvements come from the analysis doc's prioritized list. Each item below is tagged with
its analysis priority (P1/P2).

## What was implemented (in this branch)

### `staff/backend/staff/timesheets/page.tsx` (My Timesheets)
- **(P1) Progressive loading** - the page shell + summary render first; projects and entries
  load independently via `Promise.allSettled`. A failure of one does not blank the whole page.
- **(P1) Bounded requests** - `readApiResultWithTimeout` wraps `readApiResultOrThrow` with a
  12s `AbortController`, so a hung dependency cannot leave the page stuck on a spinner forever.
- **(P1) Error + retry states** - `loadError` state drives an `ErrorMessage` with a Retry
  action; partial failures are tracked (`partialLoadFailures`) and surfaced with a distinct
  message. A skeleton grid replaces the bare spinner on first load.
- **(P2) Remove unconditional save confirmation** - routine cell saves no longer open a
  confirm dialog (destructive row removal still confirms).
- **(P2) Preserve date context across week/month switching** - new `anchorDate` state;
  `handleViewModeChange` anchors to the focused date instead of jumping to the 15th.
  `handleWeekSelect` keeps the anchor in sync when picking a week.
- Kept upstream's improvements untouched: `logger` facade, `decimalToMinutes` comma-decimal
  support, and the `handleCellBlur(projectId, dateKey, currentValue)` signature.

### `staff/backend/staff/timesheets/projects/page.tsx` (Projects)
- **(P1) Decouple project-management UI from KPI data** - `canManage` is now driven by a
  dedicated `POST /api/auth/feature-check` (`staff.timesheets.projects.manage`) via
  `isCheckingPermissions`, not inferred from the KPI payload shape. The `Add Project` action
  and PM tabs no longer flicker or disappear when KPIs are slow/failing.
- **(P1) Bounded requests** - same `readApiResultWithTimeout` boundary on KPI + project loads.
- Kept upstream's `logger` facade.

### `staff/lib/timesheets-ui/TimerBar.tsx`
- **(P2) Editable timer description while running** - removed `readOnly={isRunning}`; the note
  can be edited while the timer runs and is saved on blur / Enter via `saveRunningDescription`,
  which is wired through the fork's `useGuardedMutation` (new `'timer-notes'` action) and
  updates the entry's `notes`. The description is preserved (not cleared) on stop, and any
  pending edit is flushed before the timer-stop mutation. Re-derived onto the fork's refactored
  TimerBar (`useActiveTimesheetTimer` hook, `startTimerEntry`, guarded mutations).

### Tests
- **`TC-STAFF-028-timer-note-edits-persist.spec.ts`** (new) - Playwright integration test
  covering the editable-while-running timer note: starts a timer, edits the note, asserts it
  persists on the active entry via the API and stays in the input. Self-contained fixtures +
  teardown.

## What was intentionally dropped (superseded upstream)

- **ListView inline-note save-failure fix** - the fork already replaced `apiCall` with
  `apiCallOrThrow` + `flash`, and did it better (conflict-aware via `surfaceRecordConflict`).
  My version was redundant; `ListView.tsx` is left as the fork has it.
- **My `TC-STAFF-026`** (ListView note-save-failure test) - dropped for the same reason; the
  fork already owns ListView error handling. (Note: the fork independently added its own
  `TC-STAFF-026-*` for a different feature.)
- **My `TC-STAFF-020` tweak** - the fork rewrote `TC-STAFF-020` far more thoroughly
  (weekly-view aware, `showInGrid` setup, role-scoped assertions). Kept the fork's version.
- **My original `TC-STAFF-025` edit** - it had *overwritten* an unrelated existing test
  ("Leave Request Rejection - Already-Decided State Guard") and reused its number for the timer
  test. That was wrong; the leave-request `TC-STAFF-025` is left intact and the timer test now
  lives at the fresh number `TC-STAFF-028`.

## Fork-integration / conflict notes

- `fork/develop` is a clean descendant of the original base (no divergent history), but the
  timesheets module moved. Conflicts resolved by re-deriving onto the fork rather than
  replaying patches.
- Upstream fixes preserved: structured `logger` (pino facade, `@open-mercato/shared/lib/logger`),
  comma-decimal parsing, `handleCellBlur` current-value signature, TimerBar hook refactor,
  IconButton `primary`/`destructive` variants.
- i18n keys introduced by this branch (need locale entries - see next steps):
  `staff.timesheets.my.errors.partialLoad`, `staff.timesheets.my.errors.unavailable`,
  `staff.timesheets.my.loadingContent`, `staff.timesheets.my.retry`,
  `staff.timesheets.projects.loadingPermissions`. (The TimerBar note-save error reuses the
  existing `staff.timesheets.my.errors.save`.)

## Verification status - READ BEFORE MERGING

- Typecheck was run only against stale (base-era) `node_modules` in a throwaway worktree, so it
  reported false positives for fork-only symbols (logger, IconButton variants). No error
  referenced any newly-added identifier - the code is internally consistent - but a real
  `yarn install && yarn typecheck` has NOT been run on this branch.
- No integration tests were executed. `TC-STAFF-028` has not been run.
- No in-app / manual QA was performed.

## Next steps (for the picking-up engineer)

1. `yarn install && yarn generate && yarn typecheck` on this branch; fix any real type errors.
2. Add the new i18n keys (listed above) to `staff/i18n/*.json`; run `yarn i18n:check-hardcoded`
   / `yarn i18n:check-values`.
3. Run the timesheets integration specs: `TC-STAFF-020`, `-024`, `-027`, and the new
   `TC-STAFF-028`. Confirm the original analysis failures (grid stuck on "Loading...",
   Projects "Add Project" appearing late) are resolved.
4. Manual QA of the four flows: progressive load + retry, projects permission gating,
   week/month anchor preservation, editable-while-running timer note.
5. Confirm DS compliance (`om-ds-guardian`) for the new skeleton / error / IconButton markup.
6. Consider whether an OSS spec under `.ai/specs/` should back this (per repo convention for
   new features) before opening a non-draft PR; apply the usual labels (`feature`, `needs-qa`,
   priority/risk).

## Provenance

- Original prototype base: `29f01e2c4` (open-mercato develop snapshot).
- Re-derived onto: `fork/develop` `3ab996cab`.
- Author of port + handoff: automated assist session, 2026-07-27.
