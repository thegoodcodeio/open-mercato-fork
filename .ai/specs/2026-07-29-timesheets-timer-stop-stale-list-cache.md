# Timesheets timer writes bypass the command bus and leave the CRUD list cache stale

- **Status**: Draft — ready to implement
- **Date**: 2026-07-29
- **Upstream issue**: [open-mercato/open-mercato#2609](https://github.com/open-mercato/open-mercato/issues/2609) (`bug`, `priority-high`, unassigned)
- **Umbrella**: upstream #2456 (Timesheets manual QA)
- **Fork branch**: `fix/2609-timer-stop-stale-list` (PR target: `feat/timesheets-ux-improvements`)

## TLDR

`POST /api/staff/timesheets/time-entries/{id}/timer-stop` is a hand-rolled route that writes the
time entry directly through the ORM instead of going through the command bus. The command bus is
what invalidates the opt-in CRUD list response cache, so any list payload cached **before** the stop
keeps serving the pre-stop `ended_at: null` snapshot afterwards. The UI rehydrates that as a running
timer.

Fix: implement the stop as a real command (`staff.timesheets.time_entries.stop_timer`) and have the
route delegate via `commandBus.execute`, mirroring the existing `start-timer` route/command pair.
Apply the same treatment to `[id]/timer-start`, which has the identical defect. Ship an integration
test that performs a list GET **before** the stop — the step the existing TC-STAFF-011 omits, which
is why the bug has looked unreproducible.

## Problem Statement

Manual QA (upstream #2456) reported that stopping a running timer leaves the timesheets list and
sidebar showing the timer as still running. The stop endpoint returns `200`, a direct `id=` lookup
shows the entry stopped, but the filtered date/staff list keeps returning `ended_at: null` and
`duration_minutes: 0`.

The issue stalled because a contributor could not reproduce it:

> "@pkarw Still valid? Doesn't reproduce on develop, TC-STAFF-011 passes with cache on, and QA #2855
> reported the same." — [comment, 2026-06-13](https://github.com/open-mercato/open-mercato/issues/2609#issuecomment-4698785436)

Both halves of that comment are true, and neither clears the bug. See § Why it looked unreproducible.

## Verified reproduction

Reproduced live on 2026-07-29 against the ephemeral QA environment (`yarn test:integration:ephemeral:start`,
`http://127.0.0.1:5001` — the same URL and cache configuration as the environment in the issue).

Sequence: create project → assign employee → create `source: 'timer'` entry → `timer-start` →
**filtered list GET** → `timer-stop` → filtered list GET → `?ids=` GET.

```
pre-stop  list -> ended_at=null                          duration_minutes=0
timer-stop -> 200 {"ok":true,"durationMinutes":0}
post-stop list -> ended_at=null                          duration_minutes=0   <- stale
post-stop ids= -> ended_at="2026-07-29 18:05:33.289+00"  duration_minutes=0   <- fresh
```

Control run — identical except the pre-stop list GET is removed:

```
post-stop list -> ended_at="2026-07-29 18:05:47.207+00"  duration_minutes=0   <- fresh
post-stop ids= -> ended_at="2026-07-29 18:05:47.207+00"  duration_minutes=0
```

The **only** difference between the two runs is whether the list cache key was warmed before the
stop. That isolates the mechanism to the response cache, not to the write itself.

In the issue's manual repro the warming request is step 5, "navigate away/back and reload".

## Root cause

### The write path

[`api/timesheets/time-entries/[id]/timer-stop/route.ts`](../../packages/core/src/modules/staff/api/timesheets/time-entries/%5Bid%5D/timer-stop/route.ts)
resolves scope, runs the staff mutation guards, then performs the whole mutation itself inside
`em.transactional(...)` with a `PESSIMISTIC_WRITE` lock, ending at `trx.flush()` (line 151). It then
fires `emitStaffEvent('staff.timesheets.time_entry.timer_stopped', …)` (line 155) and returns.

Nothing in that path invalidates any cache:

- No subscriber consumes `staff.timesheets.time_entry.timer_stopped` — the staff module has no
  `subscribers/` directory, and the only other references to that event id are the declaration in
  `events.ts` and the emit itself.
- The route never calls `invalidateCrudCache`.
- It never reaches the command bus, which is where invalidation normally happens.

This violates the rule in [`packages/core/AGENTS.md`](../../packages/core/AGENTS.md):

> "Implement domain writes through commands so audit, undo, cache, events, and indexing stay consistent."

### The read path

[`api/timesheets/time-entries/route.ts`](../../packages/core/src/modules/staff/api/timesheets/time-entries/route.ts)
is a `makeCrudRoute`. When `ENABLE_CRUD_API_CACHE` is on, its GET stores the **whole list payload**
under a key derived from the request query params, tagged with collection tags plus one record tag
per item ([`factory.ts:1487-1511`](../../packages/shared/src/lib/crud/factory.ts:1487)).

`invalidateCrudCache` is reachable from exactly four places:

| Caller | File |
|---|---|
| CRUD factory POST | [`factory.ts:2326`](../../packages/shared/src/lib/crud/factory.ts:2326) |
| CRUD factory PUT | [`factory.ts:2659`](../../packages/shared/src/lib/crud/factory.ts:2659) |
| CRUD factory DELETE | [`factory.ts:2946`](../../packages/shared/src/lib/crud/factory.ts:2946) |
| Command bus (after execute / after undo) | [`command-bus.ts:624`](../../packages/shared/src/lib/commands/command-bus.ts:624), `:656` |

A hand-rolled route that is neither of those invalidates nothing.

### Why the `id=` query stays fresh

The cache key includes the request's query params, so `?ids=<uuid>` and
`?staffMemberId=…&from=…&to=…` are different keys. Only the second was warmed before the stop. The
`ids=` key was cold, so it read through to the database — which is why the issue's evidence shows the
two queries disagreeing.

### Not the query index

An early hypothesis was query-index staleness (the custom routes also never reindex). Ruled out: the
query engine selects base columns from the **base table** (alias `b`) and LEFT JOINs the index only
for `cf:` custom-field access ([`query_index/lib/engine.ts:404`](../../packages/core/src/modules/query_index/lib/engine.ts:404)).
A stale index cannot produce a wrong `ended_at`. Missing reindexing on these routes is a separate,
lower-severity concern and is **out of scope** here.

## Why it looked unreproducible

**`ENABLE_CRUD_API_CACHE` is off by default** ([`crud/cache.ts:17`](../../packages/shared/src/lib/crud/cache.ts:17)
— `parseBooleanToken(process.env.ENABLE_CRUD_API_CACHE ?? '')`), so a plain `yarn dev` cannot show
the bug at all. It is on in:

- `docker-compose.fullapp.yml` and `docker-compose.fullapp.dev.yml` (`${ENABLE_CRUD_API_CACHE:-true}`)
- every `test:integration*` script in `package.json`
- the ephemeral runner, which hardcodes `ENABLE_CRUD_API_CACHE: 'true'`
  ([`integration.ts:1982`](../../packages/cli/src/lib/testing/integration.ts:1982), `:3327`)

**TC-STAFF-011 cannot catch it, cache on or off.** Its only `time-entries` list GET happens *after*
the stop ([`TC-STAFF-011.spec.ts:140`](../../packages/core/src/modules/staff/__integration__/TC-STAFF-011.spec.ts:140)).
With no pre-stop list request the key is cold and the assertion reads through to the database. The
test is structurally identical to the control run above, which is exactly why it passes.

## Proposed solution

Move the timer writes onto the command bus, so cache invalidation, audit logging and undo come from
the same mechanism the rest of the module already uses.

### Why this rather than a direct `invalidateCrudCache` call

Calling `invalidateCrudCache` from the route would fix #2609 with a smaller diff (there is precedent
for that shape in customers, #3663 — see the comments at
[`customers/api/deals/[id]/route.ts:339`](../../packages/core/src/modules/customers/api/deals/%5Bid%5D/route.ts:339)).
It was rejected because it leaves the underlying command-pattern violation in place: stopping a timer
would still produce no audit entry and no undo token, and the next hand-rolled write on this entity
would reintroduce the same class of bug. The command route fixes the cache as a *consequence* of
doing the write the way the package guide requires.

### How invalidation will reach the right tags

Two details are load-bearing and must not be dropped during implementation:

1. **`buildLog` is mandatory.** `invalidateCacheAfterExecute` returns early when
   `metadata?.resourceKind` is absent ([`command-bus.ts:576`](../../packages/shared/src/lib/commands/command-bus.ts:576)).
   The metadata comes from the command's `buildLog`. A command without `buildLog`, or one that
   returns `null`, invalidates **nothing** — the bug would survive the refactor. `buildLog` must
   return `resourceKind: 'staff.timesheets.time_entry'` and the entry id as `resourceId`.

2. **The alias is what makes the tags match.** The list route derives its `resourceKind` from its
   `actions.create.commandId` via `deriveResourceFromCommandId('staff.timesheets.time_entries.create')`
   → `staff.timesheet`, and caches under that tag. The command bus adds
   `deriveResourceFromCommandId(commandId)` to the alias set before invalidating
   ([`command-bus.ts:621`](../../packages/shared/src/lib/commands/command-bus.ts:621)), so a command
   id of `staff.timesheets.time_entries.stop_timer` also yields `staff.timesheet` and the record and
   collection tags line up. Keep the `staff.timesheets.time_entries.*` command-id prefix — a
   different prefix silently breaks invalidation.

## Architecture

### Files to add / change

| File | Change |
|---|---|
| `packages/core/src/modules/staff/data/validators.ts` | Add `staffTimeEntryStopTimerSchema` + inferred type. Scoped fields + `id: z.string().uuid()`. Mirror `staffTimeEntryStartTimerSchema` (line 294). |
| `packages/core/src/modules/staff/commands/timesheets-entries.ts` | Add `stopTimerCommand`; `registerCommand(stopTimerCommand)` next to the existing four registrations. |
| `packages/core/src/modules/staff/api/timesheets/time-entries/[id]/timer-stop/route.ts` | Replace the inline mutation with `commandBus.execute`, following `start-timer/route.ts`. |
| `packages/core/src/modules/staff/api/timesheets/time-entries/[id]/timer-start/route.ts` | Same treatment (`start_timer_existing` command — see § Phase 2). |
| `packages/core/src/modules/staff/__integration__/TC-STAFF-029-timer-stop-list-cache-consistency.spec.ts` | New regression test with the pre-stop list GET. |
| `packages/core/src/modules/staff/i18n/*.json` | Any new audit-label key (`staff.audit.timesheets.time_entries.stopTimer`). |

### `stopTimerCommand` shape

Model it on `startTimerCommand` ([`timesheets-entries.ts:310`](../../packages/core/src/modules/staff/commands/timesheets-entries.ts:310)).
The business logic moves verbatim out of the route — do not rewrite it:

- `ensureTenantScope` / `ensureOrganizationScope` / `commandInputScope` from the parsed input.
- Ownership check: the route currently resolves the caller's staff member via
  `getStaffMemberByUserId` and 403s unless `entry.staffMemberId` matches. The command should use the
  same `callerHasManageAll(ctx)` + `resolveCallerStaffMemberId(em, ctx)` pattern
  `startTimerCommand` uses, so `staff.timesheets.manage_all` holders keep working and everyone else
  is restricted to their own entries. **Preserve the existing 403 status and message key**
  (`staff.timesheets.errors.notOwner`).
- The transaction body is unchanged: `PESSIMISTIC_WRITE` lock on the entry, load segments, 409 on no
  active segment (`staff.timesheets.errors.noActiveSegment`), close the active segment, recompute
  `durationMinutes` from all `work` segments, set `endedAt`.
- After the transaction: `emitCrudSideEffects({ action: 'updated', events: staffTimeEntryCrudEvents,
  indexer: timeEntryCrudIndexer, … })` — this is also what gets the entry reindexed, which the route
  never did.
- Keep the `emitStaffEvent('staff.timesheets.time_entry.timer_stopped', …, { persistent: true })`
  emit with its existing payload shape (event ids are a frozen contract surface).
- `captureAfter` / `buildLog` / `undo` mirroring `startTimerCommand`. `undo` should restore
  `endedAt: null` and the previous `durationMinutes`, and reopen the closed segment.
- Return `{ timeEntryId, durationMinutes }` so the route can keep its response body.

### Route shape

Copy [`start-timer/route.ts`](../../packages/core/src/modules/staff/api/timesheets/time-entries/start-timer/route.ts)
wholesale: `buildContext` helper, `parseScopedCommandInput`, `commandBus.execute`, and the
`x-om-operation` undo header block. The entry id comes from the URL, not the body — keep the
existing `extractEntryIdFromUrl` helper and merge it into the command input.

### Mutation guards

The route currently calls `runStaffMutationGuards` before the write and
`runStaffMutationGuardAfterSuccess` after it. `packages/core/AGENTS.md` requires this wiring for
custom write routes, so **keep the guard calls in the route**, around the `commandBus.execute` call.
Do not move them into the command and do not drop the `afterSuccessCallbacks` loop.

## API contracts (must not change)

`POST /api/staff/timesheets/time-entries/{id}/timer-stop` is a public contract surface under
`BACKWARD_COMPATIBILITY.md`. Preserve exactly:

| Aspect | Value |
|---|---|
| Success body | `{ ok: true, durationMinutes: number }` at `200` |
| Entry not found | `404` `{ error }` (`staff.timesheets.errors.entryNotFound`) |
| Not owner | `403` `{ error }` (`staff.timesheets.errors.notOwner`) |
| No active segment | `409` `{ error }` (`staff.timesheets.errors.noActiveSegment`) |
| Unauthorized | `401` `{ error }` |
| Missing scope / generic failure | `400` `{ error }` (`staff.timesheets.errors.timerStop`) |
| Guard block | `guardResult.errorStatus ?? 422` with `guardResult.errorBody` |
| Route metadata | `requireAuth: true`, `requireFeatures: ['staff.timesheets.manage_own']` |
| `openApi` export | Keep, updated for the added `x-om-operation` response header |

Additive only: the `x-om-operation` header (undo token) appears on success, matching `start-timer`.

Both UI call sites must keep working unchanged:
[`TimerBar.tsx:234`](../../packages/core/src/modules/staff/lib/timesheets-ui/TimerBar.tsx:234) and
[`widget.client.tsx:188`](../../packages/core/src/modules/staff/widgets/dashboard/timesheets-time-reporting/widget.client.tsx:188).

## Data models

No schema change. No migration. `StaffTimeEntry` and `StaffTimeEntrySegment` are untouched.

## Implementation phases

### Phase 1 — `timer-stop` via command (required, closes #2609)

1. Add `staffTimeEntryStopTimerSchema` to `data/validators.ts`.
2. Add `stopTimerCommand` to `commands/timesheets-entries.ts` and register it.
3. Rewrite `[id]/timer-stop/route.ts` as a delegating route, keeping the mutation-guard wiring and
   the response/status contract.
4. Add the audit label translation key.
5. Add `TC-STAFF-029` (below). Confirm it fails before step 3 and passes after.

### Phase 2 — `[id]/timer-start` via command (required)

Same defect, same class: the route sets `lockedEntry.startedAt` and `lockedEntry.source` on the entry
row and never invalidates, so a list cached before a start keeps showing the entry as not started.
It also carries the `409` single-active-timer invariant (#2855) and the `409` already-started check,
both of which must move into the command unchanged.

Note this route is distinct from `start-timer/route.ts`: that one **creates and starts** a new entry
(already command-backed); this one starts an **existing** entry. Use a distinct command id such as
`staff.timesheets.time_entries.start_timer_existing` — do not overload the existing `start_timer`.

### Phase 3 — segment routes (optional, not part of #2609)

`[id]/segments/route.ts` (POST) and `[id]/segments/[segmentId]/route.ts` (PATCH) are also hand-rolled
writes that bypass the command bus. **They do not cause this bug**: both mutate only
`StaffTimeEntrySegment`, never the parent `StaffTimeEntry` row, and neither route exposes a cached
GET, so no cached list projection goes stale. Converting them is a consistency/audit improvement
only. Recommend a separate follow-up issue rather than growing this PR.

## Testing

### New: `TC-STAFF-029-timer-stop-list-cache-consistency.spec.ts`

The point of the test is the ordering, not the assertion — it must warm the cache first.

```
1. auth as employee; GET /api/staff/team-members/self
2. create time project; assign the staff member
3. POST /time-entries  { date: today, durationMinutes: 0, source: 'timer' }
4. POST /time-entries/{id}/timer-start
5. GET  /time-entries?staffMemberId=…&from=today&to=today   <- REQUIRED: warms the cache key
6. POST /time-entries/{id}/timer-stop                        -> 200
7. GET  /time-entries?staffMemberId=…&from=today&to=today    <- same key as step 5
     expect ended_at   toBeTruthy()
     expect started_at toBeTruthy()
8. GET  /time-entries?ids={id}
     expect ended_at matches step 7 (the two read paths must agree)
9. finally: delete entry + project
```

Requirements from `.ai/qa/AGENTS.md`: self-contained, creates its own fixtures via the API, cleans up
in `finally`, no reliance on seeded data. Reuse the helpers in
`@open-mercato/core/helpers/integration/timesheetFixtures` as
`TC-STAFF-028-timer-note-edits-persist.spec.ts` does.

The test only has teeth with `ENABLE_CRUD_API_CACHE=true`, which every `yarn test:integration*`
script and the ephemeral runner already set. Do not add a cache-disabled variant — it would pass
vacuously.

### Also update

`TC-STAFF-011.spec.ts` — add a pre-stop list GET so the existing timer test stops being blind to this
failure mode. Keep its current post-stop assertions.

### Manual verification

```bash
yarn test:integration:ephemeral:start
```

Then in the UI at `http://127.0.0.1:5001` (`employee@acme.com` / `secret`): start a timer, navigate
away and back (this warms the cache), stop it, reload — the timer must stay stopped in the grid, the
list view and the sidebar.

### Validation gate

```bash
yarn generate
yarn build:packages
yarn typecheck
yarn lint
yarn test
```

Plus the integration run for the two staff specs.

## Risks & impact review

| Risk | Severity | Affected area | Mitigation | Residual |
|---|---|---|---|---|
| Command omits `buildLog`, or it returns `null` → no `resourceKind` → cache never invalidated and the bug survives the refactor | **High** | `stopTimerCommand` | Explicitly asserted in § How invalidation will reach the right tags; TC-STAFF-029 fails if invalidation does not happen | Low — the test is the gate |
| Command id prefix changed → `deriveResourceFromCommandId` yields a different alias → tags never match | High | Cache invalidation | Keep the `staff.timesheets.time_entries.*` prefix | Low |
| Ownership semantics drift when moving from the route's `getStaffMemberByUserId` check to the command's `callerHasManageAll` pattern — could widen or narrow who may stop a timer | Medium | RBAC | Preserve the 403 + message key; add a case asserting a non-owner without `manage_all` still gets 403 | Medium — worth explicit review |
| Concurrency regression: losing the `PESSIMISTIC_WRITE` lock or the transaction boundary reintroduces #2416 | Medium | Timer correctness | Move the transaction body verbatim; `timer-segment-atomic-write.test.ts` covers it | Low |
| Undo handler restores a half-state (entry reopened but segment left closed, or `durationMinutes` not restored) | Medium | Undo | Capture both entry and segment state in `captureAfter`; cover undo in the command's unit test | Medium |
| New `x-om-operation` header surfaces an undo affordance for timer stops where none existed | Low | UX | Additive and consistent with `start-timer`; flag in the PR description for QA | Low |
| Response-shape drift (e.g. returning `{ ok, id }` like `start-timer` instead of `{ ok, durationMinutes }`) breaks both UI call sites | Medium | API contract | Contract table above; TimerBar reads `durationMinutes` | Low |

### Backward compatibility

- No contract surface is removed. Event id `staff.timesheets.time_entry.timer_stopped` keeps its id,
  payload and `persistent: true`.
- Route path, method, metadata, status codes and success body are unchanged.
- New command ids are additive.
- No DB schema change, so no migration and no snapshot update.
- No `UPGRADE_NOTES.md` entry required.

## PR / labelling notes

Per `.ai/docs/pr-workflow.md`: this is `bug`, `priority-high` (upstream label), `risk-medium` (shared
write path plus RBAC-adjacent refactor). The change touches no `.tsx` outside tests and no
`packages/ui/src/`, but it **does** change API behavior beyond a pure refactor, so it should keep
`needs-qa` rather than take the automated-verification `skip-qa` exemption.

Upstream #2609 lives in `open-mercato/open-mercato`; this PR targets the fork branch
`feat/timesheets-ux-improvements`. Post the reproduction evidence above on the upstream issue so the
"doesn't reproduce" thread is resolved, and reference the control run — it explains why TC-STAFF-011
was never going to catch it.

## Changelog

| Date | Change |
|---|---|
| 2026-07-29 | Spec created. Root cause verified live on the ephemeral env (repro + control). Scope narrowed from four routes to two after confirming the segment routes do not mutate the parent entry. |
