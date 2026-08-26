# Timesheets: segments orphaned when a time entry is soft-deleted

> **Status:** design complete — ready to implement.
> **Branch:** `fix/timesheets-timer-undo-orphan-segment`, based on `feat/timesheets-ux-improvements`
> **Found by:** local UI QA pass on `feat/timesheets-ux-improvements`, reported on [fork PR #1](https://github.com/thegoodcodeio/open-mercato-fork/pull/1#issuecomment-5428664628)

## 📝 TLDR

Soft-deleting a `StaffTimeEntry` never cascades to its `StaffTimeEntrySegment` rows: the segments keep `deleted_at = NULL` while pointing at a deleted parent. Where QA reproduced it — undoing `staff.timesheets.time_entries.start_timer` — the orphan is also left **open** (`ended_at = NULL`), a work segment still running against an entry that no longer exists.

This spec introduces one cascade helper, applies it to both affected paths, makes the `delete` undo restore exactly what it removed, and backfills existing orphans.

Pre-existing on `develop` (fork and `open-mercato/open-mercato` alike); **not** introduced by the timesheets UX branch.

## 📝 Overview

`StaffTimeEntrySegment` is referenced exactly twice in `packages/core/src/modules/staff/commands/timesheets-entries.ts` — the import, and one `trx.create(...)` in `startTimerCommand.execute`. **No command in the module sets `deletedAt` on a segment.** The fix is small in code and mostly a matter of getting the undo round-trip and the backfill right.

## 📝 Problem Statement

| Path | Today | Should be |
|---|---|---|
| `start_timer` → **undo** | The work segment created by `execute` stays live **and open** | Segment soft-deleted with the entry |
| `time_entries.delete` | All the entry's segments stay live | Segments soft-deleted with the entry |
| `time_entries.delete` → **undo** | Restores the entry; segments were never deleted, so they reappear (accidentally correct) | Restores the entry **and exactly the segments that delete removed** |

Reproduced on the QA instance:

```
entry:   deleted_at=2026-08-26 16:42:11+00   started_at=2026-08-26 16:41:36+00
segment: deleted_at=NULL                     ended_at=NULL
```

`startTimerCommand.execute` already declares the invariant — *"Create the timer entry AND start it inside a single transaction so a partial failure can never leave an orphaned, never-started timer entry"* — but enforces it only forward. The undo path reintroduces the very orphan the execute path guards against.

**Severity is low–medium, and the reasoning matters.** Nothing today reads segments without scoping through the parent: the single-active-timer invariant queries `staff_time_entries` with `deletedAt: null`, so an orphan cannot manufacture a phantom running timer. Exposure is to any consumer that aggregates segments directly — reporting, duration recomputation, exports — plus the ordinary cost of a soft-delete model whose children disagree with their parents.

**The pattern already exists in the codebase.** On the UX branch, `startTimerExistingCommand.undo` soft-deletes its `createdSegmentId`, and `stopTimerCommand.undo` re-opens its segment. Those newer commands are correct; this spec brings the two older ones in line.

## 📝 Proposed Solution

**One helper, called from every path that stamps `deletedAt` on an entry.** Cascade by `timeEntryId` rather than by a recorded segment id:

- No change to `TimeEntryUndoPayload`'s existing fields, so already-stored action-log entries stay readable.
- "The entry is going away, so its segments go with it" is the correct semantic for `delete`, where the entry may own many segments the command did not create.
- The alternative (record `createdSegmentId`, as `start_timer_existing` does) is precise but needs the cascade path anyway as a fallback for every log written before the fix — strictly more code for the same outcome.

**The delete round-trip is the part that needs care.** For `delete.undo` to restore exactly what it removed, `delete.execute` stamps the entry and its segments with the **same** `deletedAt` instant and records that instant in the undo payload. Undo then restores segments matching `(timeEntryId, deletedAt = recordedInstant)` — which cannot resurrect a segment the user had deleted individually beforehand, because that row carries a different timestamp.

Logs written **before** this change carry no recorded instant; their undo restores nothing, which is correct — those deletes never cascaded, so there is nothing to put back.

## 📝 Architecture

New module-local helper, beside the existing timesheets libs:

`packages/core/src/modules/staff/lib/timesheets/timeEntrySegmentCascade.ts`

```ts
export async function softDeleteSegmentsForEntry(
  em: EntityManager,
  timeEntryId: string,
  scope: { tenantId: string; organizationId: string },
  deletedAt: Date,
): Promise<number>

export async function restoreSegmentsForEntry(
  em: EntityManager,
  timeEntryId: string,
  scope: { tenantId: string; organizationId: string },
  deletedAt: Date,
): Promise<number>
```

Rules the helper obeys:

- **Tenant/organization scoped on every query** — never a bare `timeEntryId` lookup.
- **Caller-supplied `deletedAt`** so the entry and its segments share one instant; this is what makes the restore exact.
- **Open segments are closed on cascade**: a segment with `ended_at = NULL` gets `ended_at = deletedAt`. A soft-deleted row is already excluded from scoped reads, so this is defence-in-depth for any consumer that ignores `deleted_at` — and it removes the "still running" shape that made this finding worth filing. Restore reverses it only for segments it actually closed (tracked by `ended_at = deletedAt`).
- **No `em.flush()` inside the helper** — it participates in the caller's transaction, matching how the surrounding commands already work.

Call sites:

| Call site | Change |
|---|---|
| `startTimerCommand.undo` | After `entry.deletedAt = now`, cascade with the same `now` |
| `deleteTimeEntryCommand.execute` | After `entry.deletedAt = now`, cascade with the same `now`; record `now` in the undo payload |
| `deleteTimeEntryCommand.undo` | After restoring the entry, restore segments at the recorded instant (no-op when absent) |

`startTimerCommand.undo` needs no payload change: it deletes the entry outright, so cascading every live segment of that entry is unambiguous.

## 📝 Data Models

No schema change. `staff_time_entry_segments` already carries `deleted_at` and `ended_at` (both nullable).

`TimeEntryUndoPayload` gains one **optional** field:

```ts
segmentsDeletedAt?: string   // ISO instant; absent on logs written before this change
```

Additive and optional, so it does not break `BACKWARD_COMPATIBILITY.md`'s stored-payload expectations. Readers must treat absence as "no cascade happened".

### Migration — backfill existing orphans

One data migration in `packages/core/src/modules/staff/migrations/`:

```sql
UPDATE staff_time_entry_segments s
SET deleted_at = e.deleted_at,
    ended_at   = COALESCE(s.ended_at, e.ended_at, e.deleted_at),
    updated_at = now()
FROM staff_time_entries e
WHERE s.time_entry_id = e.id
  AND e.deleted_at IS NOT NULL
  AND s.deleted_at IS NULL;
```

Adopting the parent's `deleted_at` (rather than `now()`) keeps the timestamps coherent, and deliberately does **not** collide with the recorded-instant restore path, since no pre-existing log carries `segmentsDeletedAt`.

Per `AGENTS.md`, the migration ships in the PR; **applying it locally is the maintainer's call and this spec does not run `yarn db:migrate`.**

## 📝 API Contracts

Unchanged. No route, request, or response shape is touched — `DELETE /api/staff/timesheets/time-entries` and the timer routes keep their contracts. Segment list endpoints already filter on `deleted_at IS NULL`, so cascaded rows simply stop appearing.

## 📝 Edge Cases & Failure Scenarios

| Scenario | Behaviour |
|---|---|
| Entry with zero segments | Helper returns 0; no-op |
| Entry with a mix of live and previously deleted segments | Only live ones cascade; the pre-deleted keep their original timestamp and are not restored later |
| Undo of a `delete` written before this change | `segmentsDeletedAt` absent → segments untouched (correct: they were never cascaded) |
| Segment individually deleted, then the entry deleted, then undone | Individually-deleted segment keeps its own timestamp, so restore skips it — it stays deleted, as the user intended |
| Cascade fails mid-transaction | Helper does not flush; the caller's transaction rolls back entry and segments together |
| Concurrent segment write during cascade | Serialized by the caller's existing transaction/lock; a segment created after the cascade is a new orphan only if the entry delete already committed — covered by the `delete` command running both in one transaction |
| Open orphan closed by the backfill | `ended_at` set from the parent; the row is soft-deleted so no duration total changes |

## 📝 Risks & Impact Review

| Risk | Severity | Affected area | Mitigation | Residual |
|---|---|---|---|---|
| Backfill closes/deletes rows a consumer still expects | Medium | Reporting on historical data | Only touches segments whose parent is **already** soft-deleted — rows no scoped read returns today | Low: a consumer bypassing `deleted_at` would already be reading contradictory data |
| Restore resurrects a segment the user deleted deliberately | Medium | Undo correctness | Restore matches on the exact recorded instant, which an individually-deleted row cannot share | Low |
| Payload field breaks older readers | Low | Command bus | Field is optional and additive; absence is a defined case | Low |
| Cascade widens a transaction and increases lock time | Low | Timer throughput | Scoped single-table update by indexed `time_entry_id` | Low |
| Migration on a large table | Medium | Deploy | Single indexed UPDATE; row count knowable in advance via the same predicate | Low, but measure before applying |

**Blast radius:** one module, one new file, three call sites, one data migration. **Rollback:** revert the code; the backfill is not reversed by a revert, but it only marks rows whose parent is already deleted, so leaving it applied is safe.

## 📋 Phasing

- **Phase 1 — cascade + tests.** Helper, three call sites, unit + integration coverage. Independently shippable; fixes all new orphans.
- **Phase 2 — backfill.** The data migration for rows already orphaned. Separately reviewable and separately appliable.

## 📋 Implementation Plan

**Phase 1**

1. Add `lib/timesheets/timeEntrySegmentCascade.ts` with `softDeleteSegmentsForEntry` / `restoreSegmentsForEntry`, both tenant+organization scoped, neither flushing.
2. Unit-test the helper directly: zero-segment entry, mixed live/pre-deleted, open-segment closing, scope isolation (a segment in another org is never touched).
3. Call the helper from `startTimerCommand.undo` using the same `Date` instance that stamps the entry. Test: undo a start → entry soft-deleted **and** segment soft-deleted with `ended_at` set.
4. Add the optional `segmentsDeletedAt` to `TimeEntryUndoPayload`; have `deleteTimeEntryCommand.execute` cascade and record the instant. Test: delete → all live segments soft-deleted at the same instant.
5. Restore in `deleteTimeEntryCommand.undo`, keyed on the recorded instant; no-op when the field is absent. Tests: full round-trip restores exactly the cascaded set; a legacy payload restores nothing; an individually-deleted segment stays deleted.
6. Integration spec under `packages/core/src/modules/staff/__integration__/` covering start-timer → undo → assert no live orphan, and delete → undo → assert the segment set round-trips. Self-contained fixtures, cleaned up in teardown, per `.ai/qa/AGENTS.md`.

**Phase 2**

7. Add the backfill migration plus the `.snapshot-open-mercato.json` update, and a short note in the spec's Changelog. Do not run `yarn db:migrate`.
8. Ship a count query in the PR description so the reviewer can size the affected rows before applying.

Each step leaves the app working: steps 1–2 add unused code, 3 fixes one path, 4–5 the other, 6 proves both, 7–8 are data-only.

## 📝 Landing sequence

**Resolved 2026-08-26.** The fork's `develop` was fast-forwarded to `upstream/develop` (`b41f7e3e5`) — zero divergence between them now — and `feat/timesheets-ux-improvements` was pushed with its upstream merge, which collapsed PR #1's diff from 1547 commits to 45.

This spec and its implementation sit on `fix/timesheets-timer-undo-orphan-segment`, branched from `feat/timesheets-ux-improvements`.

**One consequence to keep in view:** this branch stacks on PR #1, so it cannot merge before PR #1 does. That is a deliberate trade — it gets the fix onto the same code the QA pass actually exercised. If PR #1 stalls, this branch rebases onto `develop` cleanly, because `startTimerCommand` and `deleteTimeEntryCommand` are byte-identical on both and the fix touches neither of the two commands PR #1 adds.

Basing here also means the two newer commands are present and visible while implementing: `startTimerExistingCommand.undo` (soft-deletes its `createdSegmentId`) and `stopTimerCommand.undo` (re-opens its segment) are the reference implementations this fix mirrors, and both must stay passing.

**Upstream:** the defect is equally present on `open-mercato/open-mercato` `develop`. Once this lands, the same change is worth sending upstream so the fork does not carry a permanent divergence in a file upstream keeps changing.

## 📝 Final Compliance Report

- **Module boundaries** — helper is module-local; no cross-module ORM relationship introduced.
- **Tenant scoping** — every helper query filters `tenantId` + `organizationId`; a scope-isolation test is mandatory (Step 2).
- **Canonical mechanisms** — reuses the existing command-bus undo contract and the module's existing soft-delete convention; invents nothing.
- **Backward compatibility** — one additive optional payload field; no API, event, DI-key, ACL or route change. No `BACKWARD_COMPATIBILITY.md` surface broken.
- **Migrations** — generated and committed with the snapshot; not applied.
- **Testability** — every step has a named test; the two undo round-trips get integration coverage.
- **Generated files** — none edited by hand.

## 📝 Changelog

| Date | Change |
|---|---|
| 2026-08-26 | Initial spec. Scope, cascade mechanism and backfill decided. |
| 2026-08-26 | Landing sequence resolved: fork `develop` synced to `upstream/develop`; this branch bases on `feat/timesheets-ux-improvements`. |
