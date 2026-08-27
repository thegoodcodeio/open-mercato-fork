import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { LockMode } from '@mikro-orm/core'
import { buildChanges, emitCrudSideEffects, emitCrudUndoSideEffects } from '@open-mercato/shared/lib/commands/helpers'
import { makeCreateRedo } from '@open-mercato/shared/lib/commands/redo'
import type { CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { StaffTimeEntry, StaffTimeEntrySegment, StaffTimeProject, type StaffTimeEntrySource } from '../data/entities'
import { emitStaffEvent } from '../events'

// The time-entries CRUD list route caches under `staff.timesheet`. What actually
// flushes that tag on execute AND undo is the command bus: `deriveResourceFromCommandId`
// maps every `staff.timesheets.*` id onto it, which is why the ids below keep that
// prefix (#2609). `cacheAliases` is declared for the `packages/core/AGENTS.md`
// convention only — no runtime reader consumes `CrudIndexerConfig.cacheAliases` today
// (the bus reads `buildLog(...).context.cacheAliases`), so do not rely on it to reach
// a tag the command id cannot derive.
const timeEntryCrudIndexer: CrudIndexerConfig<StaffTimeEntry> = {
  entityType: 'staff:staff_time_entry',
  cacheAliases: ['staff.timesheet'],
}
import {
  staffTimeEntryCreateSchema,
  staffTimeEntryStartTimerSchema,
  staffTimeEntryStartTimerExistingSchema,
  staffTimeEntryStopTimerSchema,
  staffTimeEntryUpdateSchema,
  type StaffTimeEntryCreateInput,
  type StaffTimeEntryStartTimerInput,
  type StaffTimeEntryStartTimerExistingInput,
  type StaffTimeEntryStopTimerInput,
  type StaffTimeEntryUpdateInput,
} from '../data/validators'
import { staffTimeEntryCrudEvents } from '../lib/crud'
import {
  applyScopeToWhere,
  commandActorScope,
  commandInputScope,
  ensureOrganizationScope,
  ensureTenantScope,
  extractUndoPayload,
  scopeForDecryption,
  scopedStaffSnapshotWhere,
  staffSnapshotDecryptionScope,
  staffSnapshotScopeFromContext,
  staffSnapshotScopeFromSnapshot,
  type StaffSnapshotScope,
} from './shared'
import { getStaffMemberByUserId } from '../lib/staffMemberResolver'
import { restoreSegmentsForEntry, softDeleteSegmentsForEntry } from '../lib/timesheets/timeEntrySegmentCascade'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('staff')

type RbacServiceLike = {
  userHasAllFeatures: (
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<boolean>
}

/**
 * Returns true when the caller holds `staff.timesheets.manage_all`, honoring
 * wildcard ACL grants (`staff.*`, `*`) and the super-admin flag via the cached
 * rbacService. Returns false when no auth context (e.g. system/CLI ctx) so
 * write paths that lack a caller identity are NOT silently elevated.
 */
async function callerHasManageAll(ctx: {
  auth?: { sub?: string | null; tenantId?: string | null; orgId?: string | null } | null
  container: { resolve: (token: string) => unknown }
}): Promise<boolean> {
  const userId = ctx.auth?.sub
  if (!userId) return false
  try {
    const rbac = ctx.container.resolve('rbacService') as RbacServiceLike | undefined
    if (!rbac?.userHasAllFeatures) return false
    return await rbac.userHasAllFeatures(
      userId,
      ['staff.timesheets.manage_all'],
      { tenantId: ctx.auth?.tenantId ?? null, organizationId: ctx.auth?.orgId ?? null },
    )
  } catch {
    return false
  }
}

async function resolveCallerStaffMemberId(
  em: EntityManager,
  ctx: { auth?: { sub?: string | null; tenantId?: string | null; orgId?: string | null } | null },
): Promise<string | null> {
  const userId = ctx.auth?.sub
  if (!userId) return null
  const member = await getStaffMemberByUserId(
    em,
    userId,
    ctx.auth?.tenantId ?? null,
    ctx.auth?.orgId ?? null,
  )
  return member?.id ?? null
}

/**
 * Verifies the referenced time project exists and is in-scope (same tenant + org,
 * not soft-deleted). Throws 422 if the ID is provided but unresolvable.
 * No-op when projectId is null/undefined (timeProjectId is optional on entries).
 */
async function assertTimeProjectInScope(
  em: EntityManager,
  projectId: string | null | undefined,
  tenantId: string,
  organizationId: string,
): Promise<void> {
  if (!projectId) return
  const exists = await em.findOne(
    StaffTimeProject,
    { id: projectId, tenantId, organizationId, deletedAt: null },
    { fields: ['id'] },
  )
  if (!exists) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(422, {
      error: translate('staff.timesheets.errors.projectNotFound', 'Time project not found or not accessible.'),
      fieldErrors: {
        timeProjectId: translate('staff.timesheets.errors.projectNotFound', 'Time project not found or not accessible.'),
      },
    })
  }
}

type TimeEntrySnapshot = {
  id: string
  tenantId: string
  organizationId: string
  staffMemberId: string
  date: string
  durationMinutes: number
  startedAt: string | null
  endedAt: string | null
  notes: string | null
  timeProjectId: string | null
  customerId: string | null
  dealId: string | null
  orderId: string | null
  source: string
  deletedAt: string | null
}

type TimeEntryUndoPayload = {
  before?: TimeEntrySnapshot | null
  after?: TimeEntrySnapshot | null
  /**
   * The instant `deleteTimeEntryCommand.execute` stamped on the entry AND every
   * segment it cascaded, which `undo` uses to restore exactly that set. Absent on
   * logs written before the cascade existed — those deletes never touched
   * segments, so their undo correctly restores none.
   */
  segmentsDeletedAt?: string
}

/**
 * Everything undo needs to reverse a timer stop. `loadTimeEntrySnapshot` covers
 * the entry only, but a stop spans two rows — the entry and the segment it
 * closed — and `durationMinutes` is not reconstructible from the after-state
 * (an entry may already carry earlier completed segments). Captured inside
 * `execute`, under the same PESSIMISTIC_WRITE lock that performs the stop, so
 * the recorded segment is provably the one that was closed.
 */
type TimeEntryStopUndoState = {
  entryId: string
  tenantId: string
  organizationId: string
  staffMemberId: string
  endedAt: string | null
  durationMinutes: number
  updatedAt: string | null
  activeSegmentId: string
  activeSegmentEndedAt: string | null
}

type TimeEntryStopUndoPayload = {
  before?: TimeEntryStopUndoState | null
}

/**
 * Everything undo needs to reverse starting an EXISTING entry's timer. Unlike
 * `startTimerCommand` — which creates the entry and can therefore undo by
 * soft-deleting it — this command only flips an entry that already existed, so
 * undo has to restore the prior `startedAt` / `source` and retire the work
 * segment the start created. Captured inside `execute` under the same
 * PESSIMISTIC_WRITE lock, so the recorded segment is provably the one opened.
 */
type TimeEntryStartExistingUndoState = {
  entryId: string
  tenantId: string
  organizationId: string
  staffMemberId: string
  startedAt: string | null
  /**
   * The end the entry carried before the start cleared it. Absent on logs written
   * before `execute` cleared `endedAt` — those starts left the value in place, and
   * the undo guard below refuses whenever an end is present, so a legacy payload
   * only ever reaches the restore with `endedAt` already null.
   */
  endedAt?: string | null
  source: StaffTimeEntrySource
  createdSegmentId: string
}

type TimeEntryStartExistingUndoPayload = {
  before?: TimeEntryStartExistingUndoState | null
}

async function loadTimeEntrySnapshot(em: EntityManager, id: string, scope?: StaffSnapshotScope | null): Promise<TimeEntrySnapshot | null> {
  const entry = await findOneWithDecryption(
    em,
    StaffTimeEntry,
    scopedStaffSnapshotWhere(id, scope),
    undefined,
    staffSnapshotDecryptionScope(scope),
  )
  if (!entry) return null
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    organizationId: entry.organizationId,
    staffMemberId: entry.staffMemberId,
    date: entry.date instanceof Date ? entry.date.toISOString().split('T')[0] : String(entry.date),
    durationMinutes: entry.durationMinutes,
    startedAt: entry.startedAt ? entry.startedAt.toISOString() : null,
    endedAt: entry.endedAt ? entry.endedAt.toISOString() : null,
    notes: entry.notes ?? null,
    timeProjectId: entry.timeProjectId ?? null,
    customerId: entry.customerId ?? null,
    dealId: entry.dealId ?? null,
    orderId: entry.orderId ?? null,
    source: entry.source,
    deletedAt: entry.deletedAt ? entry.deletedAt.toISOString() : null,
  }
}

function timeEntrySeedFromSnapshot(snapshot: TimeEntrySnapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    staffMemberId: snapshot.staffMemberId,
    date: snapshot.date,
    durationMinutes: snapshot.durationMinutes,
    startedAt: snapshot.startedAt ? new Date(snapshot.startedAt) : null,
    endedAt: snapshot.endedAt ? new Date(snapshot.endedAt) : null,
    notes: snapshot.notes ?? null,
    timeProjectId: snapshot.timeProjectId ?? null,
    customerId: snapshot.customerId ?? null,
    dealId: snapshot.dealId ?? null,
    orderId: snapshot.orderId ?? null,
    source: (snapshot.source ?? 'manual') as StaffTimeEntrySource,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }
}

const createTimeEntryCommand: CommandHandler<StaffTimeEntryCreateInput, { timeEntryId: string }> = {
  id: 'staff.timesheets.time_entries.create',
  async execute(rawInput, ctx) {
    const parsed = staffTimeEntryCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    commandInputScope(ctx, parsed.tenantId, parsed.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // Ownership enforcement: callers without `staff.timesheets.manage_all`
    // can only create entries attributed to themselves. Silent override
    // (mirrors `bulk/route.ts` behavior) so the request body's staffMemberId
    // can't forge an entry under a colleague's identity.
    let effectiveStaffMemberId = parsed.staffMemberId
    if (!(await callerHasManageAll(ctx))) {
      const callerStaffMemberId = await resolveCallerStaffMemberId(em, ctx)
      if (!callerStaffMemberId) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(403, {
          error: translate('staff.timesheets.errors.noStaffMember', 'No staff member linked to your account.'),
        })
      }
      effectiveStaffMemberId = callerStaffMemberId
    }

    // Validate referenced timeProjectId is in-scope before persisting.
    // Without this check a foreign or stale UUID would produce a dangling reference.
    await assertTimeProjectInScope(em, parsed.timeProjectId ?? null, parsed.tenantId, parsed.organizationId)

    const now = new Date()
    const entry = em.create(StaffTimeEntry, {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      staffMemberId: effectiveStaffMemberId,
      date: parsed.date,
      durationMinutes: parsed.durationMinutes,
      startedAt: parsed.startedAt ?? null,
      endedAt: parsed.endedAt ?? null,
      notes: parsed.notes ?? null,
      timeProjectId: parsed.timeProjectId ?? null,
      customerId: parsed.customerId ?? null,
      dealId: parsed.dealId ?? null,
      orderId: parsed.orderId ?? null,
      source: parsed.source ?? 'manual',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    em.persist(entry)
    await em.flush()

    await emitCrudSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'created',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })

    return { timeEntryId: entry.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const snapshot = await loadTimeEntrySnapshot(em, result.timeEntryId, staffSnapshotScopeFromContext(ctx))
    if (!snapshot) return null
    return { snapshot }
  },
  buildLog: async ({ result, ctx }) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const snapshot = await loadTimeEntrySnapshot(em, result.timeEntryId, staffSnapshotScopeFromContext(ctx))
    if (!snapshot) return null
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('staff.audit.timesheets.time_entries.create', 'Create time entry'),
      resourceKind: 'staff.timesheets.time_entry',
      resourceId: snapshot.id,
      tenantId: snapshot.tenantId,
      organizationId: snapshot.organizationId,
      snapshotAfter: snapshot,
      payload: {
        undo: {
          after: snapshot,
        } satisfies TimeEntryUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TimeEntryUndoPayload>(logEntry)
    const after = payload?.after
    if (!after) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const entry = await em.findOne(StaffTimeEntry, scopedStaffSnapshotWhere(after.id, staffSnapshotScopeFromSnapshot(after)))
    if (entry) {
      // An entry created manually can still accrue segments afterwards — the
      // segments API adds them, and `start_timer_existing` opens one. Undoing the
      // create must take them with it, on the same instant so `redo` can reverse
      // exactly this set.
      const deletedAt = new Date()
      entry.deletedAt = deletedAt
      await softDeleteSegmentsForEntry(
        em,
        entry.id,
        { tenantId: entry.tenantId, organizationId: entry.organizationId },
        deletedAt,
      )
      await em.flush()

      await emitCrudUndoSideEffects({
        dataEngine: ctx.container.resolve('dataEngine'),
        action: 'deleted',
        entity: entry,
        identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
        events: staffTimeEntryCrudEvents,
      })
    }
  },
  redo: makeCreateRedo<StaffTimeEntry, TimeEntrySnapshot, StaffTimeEntryCreateInput, { timeEntryId: string }>({
    entityClass: StaffTimeEntry,
    getSnapshotId: (snapshot) => snapshot.id,
    seedFromSnapshot: timeEntrySeedFromSnapshot,
    buildResult: (entity) => ({ timeEntryId: entity.id }),
    events: staffTimeEntryCrudEvents,
    indexer: timeEntryCrudIndexer,
    // Runs while the row is still soft-deleted, so the entry's own `deletedAt` is
    // the instant `undo` cascaded on — no payload field needed to carry it. Mutations
    // here share the redo's EntityManager and flush with the row restore.
    beforeRestore: async ({ em, snapshot }) => {
      // Scope is spelled out rather than taken from `scopedStaffSnapshotWhere` so both
      // keys are always applied: that helper omits `tenantId` or `organizationId`
      // whenever the snapshot's value is falsy, which would silently widen this lookup.
      const softDeleted = await em.findOne(StaffTimeEntry, {
        id: snapshot.id,
        tenantId: snapshot.tenantId,
        organizationId: snapshot.organizationId,
      })
      if (!softDeleted?.deletedAt) return
      await restoreSegmentsForEntry(
        em,
        snapshot.id,
        { tenantId: snapshot.tenantId, organizationId: snapshot.organizationId },
        softDeleted.deletedAt,
      )
    },
  }),
}

const startTimerCommand: CommandHandler<StaffTimeEntryStartTimerInput, { timeEntryId: string }> = {
  id: 'staff.timesheets.time_entries.start_timer',
  async execute(rawInput, ctx) {
    const parsed = staffTimeEntryStartTimerSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    commandInputScope(ctx, parsed.tenantId, parsed.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()

    // Ownership enforcement mirrors createTimeEntryCommand: callers without
    // `staff.timesheets.manage_all` can only start their own timer, so the
    // request body's staffMemberId can't start a timer under a colleague's id.
    let effectiveStaffMemberId = parsed.staffMemberId
    if (!(await callerHasManageAll(ctx))) {
      const callerStaffMemberId = await resolveCallerStaffMemberId(em, ctx)
      if (!callerStaffMemberId) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(403, {
          error: translate('staff.timesheets.errors.noStaffMember', 'No staff member linked to your account.'),
        })
      }
      effectiveStaffMemberId = callerStaffMemberId
    }

    await assertTimeProjectInScope(em, parsed.timeProjectId ?? null, parsed.tenantId, parsed.organizationId)

    const scopeCtx = { tenantId: parsed.tenantId, organizationId: parsed.organizationId }

    // Create the timer entry AND start it inside a single transaction so a
    // partial failure can never leave an orphaned, never-started timer entry
    // (issue #3311 — the legacy two-request create-then-start flow). The
    // single-active-timer invariant (#2855) is re-checked here so a second
    // surface cannot create a parallel running timer for the same staff member.
    const { entry, startedAt } = await em.transactional(async (trx) => {
      const otherRunningEntry = await findOneWithDecryption(
        trx,
        StaffTimeEntry,
        {
          tenantId: parsed.tenantId,
          organizationId: parsed.organizationId,
          staffMemberId: effectiveStaffMemberId,
          startedAt: { $ne: null },
          endedAt: null,
          deletedAt: null,
        },
        {},
        scopeCtx,
      )
      if (otherRunningEntry) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(409, {
          error: translate(
            'staff.timesheets.errors.timerAlreadyRunning',
            'Another timer is already running. Stop it before starting a new one.',
          ),
        })
      }

      const startedAt = new Date()
      const entry = trx.create(StaffTimeEntry, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        staffMemberId: effectiveStaffMemberId,
        date: parsed.date,
        durationMinutes: 0,
        startedAt,
        endedAt: null,
        notes: parsed.notes ?? null,
        timeProjectId: parsed.timeProjectId ?? null,
        customerId: null,
        dealId: null,
        orderId: null,
        source: 'timer',
        createdAt: startedAt,
        updatedAt: startedAt,
        deletedAt: null,
      })
      // Flush so the DB-generated id is populated before the work segment
      // references it; both writes commit together when the transaction closes.
      await trx.flush()

      const segmentData = {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        timeEntryId: entry.id,
        startedAt,
        segmentType: 'work' as const,
      }
      trx.create(StaffTimeEntrySegment, segmentData as never)
      await trx.flush()

      return { entry, startedAt }
    })

    await emitCrudSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'created',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })

    void emitStaffEvent('staff.timesheets.time_entry.timer_started', {
      id: entry.id,
      staffMemberId: effectiveStaffMemberId,
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      startedAt: startedAt.toISOString(),
    }, { persistent: true }).catch((err) => {
      logger.error('staff.timesheets emit timer_started failed', { err })
    })

    return { timeEntryId: entry.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const snapshot = await loadTimeEntrySnapshot(em, result.timeEntryId, staffSnapshotScopeFromContext(ctx))
    if (!snapshot) return null
    return { snapshot }
  },
  buildLog: async ({ result, ctx }) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const snapshot = await loadTimeEntrySnapshot(em, result.timeEntryId, staffSnapshotScopeFromContext(ctx))
    if (!snapshot) return null
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('staff.audit.timesheets.time_entries.startTimer', 'Start timer'),
      resourceKind: 'staff.timesheets.time_entry',
      resourceId: snapshot.id,
      tenantId: snapshot.tenantId,
      organizationId: snapshot.organizationId,
      snapshotAfter: snapshot,
      payload: {
        undo: {
          after: snapshot,
        } satisfies TimeEntryUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TimeEntryUndoPayload>(logEntry)
    const after = payload?.after
    if (!after) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const entry = await em.findOne(StaffTimeEntry, scopedStaffSnapshotWhere(after.id, staffSnapshotScopeFromSnapshot(after)))
    if (entry) {
      // `execute` created the entry and opened a work segment on it, so undoing the
      // start has to retire both. Cascading on the same instant keeps the segment
      // from outliving its parent as a still-running orphan.
      const deletedAt = new Date()
      entry.deletedAt = deletedAt
      await softDeleteSegmentsForEntry(
        em,
        entry.id,
        { tenantId: entry.tenantId, organizationId: entry.organizationId },
        deletedAt,
      )
      await em.flush()

      await emitCrudUndoSideEffects({
        dataEngine: ctx.container.resolve('dataEngine'),
        action: 'deleted',
        entity: entry,
        identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
        events: staffTimeEntryCrudEvents,
      })
    }
  },
}

type StopTimerResult = {
  timeEntryId: string
  durationMinutes: number
  undoState: TimeEntryStopUndoState
}

const stopTimerCommand: CommandHandler<StaffTimeEntryStopTimerInput, StopTimerResult> = {
  id: 'staff.timesheets.time_entries.stop_timer',
  async prepare(rawInput, ctx) {
    const parsed = staffTimeEntryStopTimerSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager)
    const snapshot = await loadTimeEntrySnapshot(em, parsed.id, staffSnapshotScopeFromContext(ctx))
    if (!snapshot) return {}
    return { before: snapshot }
  },
  async execute(rawInput, ctx) {
    const parsed = staffTimeEntryStopTimerSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    commandInputScope(ctx, parsed.tenantId, parsed.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scopeCtx = { tenantId: parsed.tenantId, organizationId: parsed.organizationId }

    const entry = await findOneWithDecryption(
      em,
      StaffTimeEntry,
      { id: parsed.id, tenantId: parsed.tenantId, organizationId: parsed.organizationId, deletedAt: null },
      {},
      scopeCtx,
    )
    if (!entry) {
      const { translate } = await resolveTranslations()
      throw new CrudHttpError(404, { error: translate('staff.timesheets.errors.entryNotFound', 'Time entry not found.') })
    }

    // Ownership enforcement is deliberately owner-only here: unlike
    // createTimeEntryCommand / startTimerCommand / updateTimeEntryCommand, this
    // command has NO `staff.timesheets.manage_all` bypass, because the endpoint
    // it backs has never had one. Adding `callerHasManageAll(ctx)` would grant a
    // new ability — stopping a colleague's running timer — which is an RBAC
    // behavior change, not a refactor. Do not "fix" this inconsistency here.
    const callerUserId = ctx.auth?.sub ?? null
    const staffMember = callerUserId
      ? await getStaffMemberByUserId(em, callerUserId, parsed.tenantId, parsed.organizationId)
      : null
    if (!staffMember || entry.staffMemberId !== staffMember.id) {
      const { translate } = await resolveTranslations()
      throw new CrudHttpError(403, {
        error: translate('staff.timesheets.errors.notOwner', 'You can only manage your own time entries.'),
      })
    }

    // Recompute and persist the timer state inside a single transaction with a
    // PESSIMISTIC_WRITE lock on the time entry row, so concurrent timer-stop /
    // segment writes on the same entry serialize instead of racing on a shared
    // in-memory snapshot (issue #2416).
    const { stoppedAt, durationMinutes, undoState } = await em.transactional(async (trx) => {
      const lockedEntry = await findOneWithDecryption(
        trx,
        StaffTimeEntry,
        { id: parsed.id, tenantId: parsed.tenantId, organizationId: parsed.organizationId, deletedAt: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scopeCtx,
      )
      if (!lockedEntry) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(404, { error: translate('staff.timesheets.errors.entryNotFound', 'Time entry not found.') })
      }

      const segments = await findWithDecryption(
        trx,
        StaffTimeEntrySegment,
        {
          timeEntryId: lockedEntry.id,
          tenantId: parsed.tenantId,
          organizationId: parsed.organizationId,
          deletedAt: null,
        },
        {},
        scopeCtx,
      )

      const activeSegment = segments.find((segment) => !segment.endedAt)
      if (!activeSegment) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(409, {
          error: translate('staff.timesheets.errors.noActiveSegment', 'No active timer segment found for this entry.'),
        })
      }

      const beforeState: TimeEntryStopUndoState = {
        entryId: lockedEntry.id,
        tenantId: lockedEntry.tenantId,
        organizationId: lockedEntry.organizationId,
        staffMemberId: lockedEntry.staffMemberId,
        endedAt: lockedEntry.endedAt ? lockedEntry.endedAt.toISOString() : null,
        durationMinutes: lockedEntry.durationMinutes,
        updatedAt: lockedEntry.updatedAt ? lockedEntry.updatedAt.toISOString() : null,
        activeSegmentId: activeSegment.id,
        activeSegmentEndedAt: activeSegment.endedAt ? activeSegment.endedAt.toISOString() : null,
      }

      const stoppedAt = new Date()
      activeSegment.endedAt = stoppedAt
      lockedEntry.endedAt = stoppedAt

      const allSegments = segments.map((segment) => {
        if (segment.id === activeSegment.id) {
          return { ...segment, endedAt: stoppedAt }
        }
        return segment
      })

      const totalWorkMinutes = allSegments
        .filter((segment) => segment.segmentType === 'work' && segment.startedAt && segment.endedAt)
        .reduce((sum, segment) => {
          const startMs = new Date(segment.startedAt).getTime()
          const endMs = new Date(segment.endedAt!).getTime()
          return sum + (endMs - startMs)
        }, 0)

      const computedMinutes = Math.round(totalWorkMinutes / 60000)
      lockedEntry.durationMinutes = computedMinutes
      lockedEntry.updatedAt = stoppedAt

      await trx.flush()
      return { stoppedAt, durationMinutes: computedMinutes, undoState: beforeState }
    })

    await emitCrudSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'updated',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })

    void emitStaffEvent('staff.timesheets.time_entry.timer_stopped', {
      id: entry.id,
      staffMemberId: entry.staffMemberId,
      tenantId: entry.tenantId,
      organizationId: entry.organizationId,
      stoppedAt: stoppedAt.toISOString(),
      durationMinutes,
    }, { persistent: true }).catch((err) => {
      logger.error('staff.timesheets emit timer_stopped failed', { err })
    })

    return { timeEntryId: entry.id, durationMinutes, undoState }
  },
  // `buildLog` is mandatory, not optional polish: the command bus skips cache
  // invalidation entirely when the log metadata carries no `resourceKind`, which
  // would leave the stale-list bug (#2609) in place after the refactor.
  buildLog: async ({ result, snapshots, ctx }) => {
    const before = (snapshots.before ?? null) as TimeEntrySnapshot | null
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const after = await loadTimeEntrySnapshot(
      em,
      result.timeEntryId,
      before ? staffSnapshotScopeFromSnapshot(before) : staffSnapshotScopeFromContext(ctx),
    )
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('staff.audit.timesheets.time_entries.stopTimer', 'Stop timer'),
      resourceKind: 'staff.timesheets.time_entry',
      resourceId: result.timeEntryId,
      tenantId: result.undoState.tenantId,
      organizationId: result.undoState.organizationId,
      snapshotBefore: before ?? undefined,
      snapshotAfter: after ?? undefined,
      changes: before && after
        ? buildChanges(
            before as unknown as Record<string, unknown>,
            after as unknown as Record<string, unknown>,
            ['durationMinutes', 'endedAt'],
          )
        : undefined,
      payload: {
        undo: {
          before: result.undoState,
        } satisfies TimeEntryStopUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TimeEntryStopUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scopeCtx = { tenantId: before.tenantId, organizationId: before.organizationId }

    // Undo takes the same PESSIMISTIC_WRITE lock `execute` does: without it an
    // undo racing a concurrent segment write reintroduces #2416 through the
    // back door.
    const entry = await em.transactional(async (trx) => {
      const lockedEntry = await findOneWithDecryption(
        trx,
        StaffTimeEntry,
        { id: before.entryId, tenantId: before.tenantId, organizationId: before.organizationId, deletedAt: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scopeCtx,
      )
      if (!lockedEntry) return null

      // Reopening a stopped timer makes it running again, so the
      // single-active-timer invariant (#2855) has to hold afterwards. If the
      // staff member started another timer in the meantime, refuse rather than
      // leave them with two running entries. The shared undo endpoint collapses
      // this to an opaque 400 today; 409 is still the correct internal signal.
      const otherRunningEntry = await findOneWithDecryption(
        trx,
        StaffTimeEntry,
        {
          id: { $ne: before.entryId },
          tenantId: before.tenantId,
          organizationId: before.organizationId,
          staffMemberId: before.staffMemberId,
          startedAt: { $ne: null },
          endedAt: null,
          deletedAt: null,
        },
        {},
        scopeCtx,
      )
      if (otherRunningEntry) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(409, {
          error: translate(
            'staff.timesheets.errors.timerAlreadyRunning',
            'Another timer is already running. Stop it before starting a new one.',
          ),
        })
      }

      const segment = await findOneWithDecryption(
        trx,
        StaffTimeEntrySegment,
        {
          id: before.activeSegmentId,
          timeEntryId: before.entryId,
          tenantId: before.tenantId,
          organizationId: before.organizationId,
        },
        {},
        scopeCtx,
      )
      if (segment) {
        segment.endedAt = before.activeSegmentEndedAt ? new Date(before.activeSegmentEndedAt) : null
      }

      lockedEntry.endedAt = before.endedAt ? new Date(before.endedAt) : null
      lockedEntry.durationMinutes = before.durationMinutes
      lockedEntry.updatedAt = new Date()

      await trx.flush()
      return lockedEntry
    })

    if (!entry) return

    await emitCrudUndoSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'updated',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })
  },
}

type StartTimerExistingResult = {
  timeEntryId: string
  undoState: TimeEntryStartExistingUndoState
}

const startTimerExistingCommand: CommandHandler<StaffTimeEntryStartTimerExistingInput, StartTimerExistingResult> = {
  // Deliberately NOT `start_timer`: that command creates and starts a new entry,
  // this one starts an entry that already exists. They take different inputs and
  // undo differently, so overloading one id would break both audit trails.
  id: 'staff.timesheets.time_entries.start_timer_existing',
  async prepare(rawInput, ctx) {
    const parsed = staffTimeEntryStartTimerExistingSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager)
    const snapshot = await loadTimeEntrySnapshot(em, parsed.id, staffSnapshotScopeFromContext(ctx))
    if (!snapshot) return {}
    return { before: snapshot }
  },
  async execute(rawInput, ctx) {
    const parsed = staffTimeEntryStartTimerExistingSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    commandInputScope(ctx, parsed.tenantId, parsed.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scopeCtx = { tenantId: parsed.tenantId, organizationId: parsed.organizationId }

    const entry = await findOneWithDecryption(
      em,
      StaffTimeEntry,
      { id: parsed.id, tenantId: parsed.tenantId, organizationId: parsed.organizationId, deletedAt: null },
      {},
      scopeCtx,
    )
    if (!entry) {
      const { translate } = await resolveTranslations()
      throw new CrudHttpError(404, { error: translate('staff.timesheets.errors.entryNotFound', 'Time entry not found.') })
    }

    // Owner-only, matching both the route this replaces and stopTimerCommand.
    // The `staff.timesheets.manage_all` bypass in createTimeEntryCommand /
    // startTimerCommand is NOT copied: it would newly permit starting a
    // colleague's timer, which is an RBAC change rather than a refactor.
    const callerUserId = ctx.auth?.sub ?? null
    const staffMember = callerUserId
      ? await getStaffMemberByUserId(em, callerUserId, parsed.tenantId, parsed.organizationId)
      : null
    if (!staffMember || entry.staffMemberId !== staffMember.id) {
      const { translate } = await resolveTranslations()
      throw new CrudHttpError(403, {
        error: translate('staff.timesheets.errors.notOwner', 'You can only manage your own time entries.'),
      })
    }

    // Same transaction + PESSIMISTIC_WRITE shape the route used: re-check
    // startedAt under the lock so two concurrent starts on one entry cannot both
    // open an initial work segment (#2416), and re-check the single-active-timer
    // invariant (#2855) against the staff member's other entries.
    const { startedAt, undoState } = await em.transactional(async (trx) => {
      const lockedEntry = await findOneWithDecryption(
        trx,
        StaffTimeEntry,
        { id: parsed.id, tenantId: parsed.tenantId, organizationId: parsed.organizationId, deletedAt: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scopeCtx,
      )
      if (!lockedEntry) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(404, { error: translate('staff.timesheets.errors.entryNotFound', 'Time entry not found.') })
      }
      if (lockedEntry.startedAt) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(409, {
          error: translate('staff.timesheets.errors.timerAlreadyStarted', 'Timer is already started for this entry.'),
        })
      }

      const otherRunningEntry = await findOneWithDecryption(
        trx,
        StaffTimeEntry,
        {
          tenantId: parsed.tenantId,
          organizationId: parsed.organizationId,
          staffMemberId: lockedEntry.staffMemberId,
          id: { $ne: lockedEntry.id },
          startedAt: { $ne: null },
          endedAt: null,
          deletedAt: null,
        },
        {},
        scopeCtx,
      )
      if (otherRunningEntry) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(409, {
          error: translate(
            'staff.timesheets.errors.timerAlreadyRunning',
            'Another timer is already running. Stop it before starting a new one.',
          ),
        })
      }

      const previousSource = lockedEntry.source
      const previousEndedAt = lockedEntry.endedAt
      const startedAt = new Date()
      lockedEntry.startedAt = startedAt
      // A start opens a fresh work segment, so any end the entry already carried
      // describes work that finished before this start. Leaving it in place writes
      // `ended_at < started_at` and breaks two things that read the pair together:
      // the running-timer lookup (`started_at IS NOT NULL AND ended_at IS NULL`,
      // see `buildTimeEntryListFilters`) stops matching the entry the user just
      // started, and this command's own undo — which treats a present `endedAt` as
      // proof that a stop landed after the start — refuses forever.
      lockedEntry.endedAt = null
      lockedEntry.source = 'timer'

      const segment = trx.create(StaffTimeEntrySegment, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        timeEntryId: lockedEntry.id,
        startedAt,
        segmentType: 'work' as const,
      } as never) as StaffTimeEntrySegment

      await trx.flush()

      return {
        startedAt,
        undoState: {
          entryId: lockedEntry.id,
          tenantId: lockedEntry.tenantId,
          organizationId: lockedEntry.organizationId,
          staffMemberId: lockedEntry.staffMemberId,
          startedAt: null,
          endedAt: previousEndedAt ? previousEndedAt.toISOString() : null,
          source: previousSource,
          createdSegmentId: segment.id,
        } satisfies TimeEntryStartExistingUndoState,
      }
    })

    await emitCrudSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'updated',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })

    void emitStaffEvent('staff.timesheets.time_entry.timer_started', {
      id: entry.id,
      staffMemberId: entry.staffMemberId,
      tenantId: entry.tenantId,
      organizationId: entry.organizationId,
      startedAt: startedAt.toISOString(),
    }, { persistent: true }).catch((err) => {
      logger.error('staff.timesheets emit timer_started failed', { err })
    })

    return { timeEntryId: entry.id, undoState }
  },
  // Mandatory for the same reason as stopTimerCommand: the command bus skips
  // cache invalidation entirely when the log metadata carries no `resourceKind`,
  // which is the exact defect this conversion exists to fix.
  buildLog: async ({ result, snapshots, ctx }) => {
    const before = (snapshots.before ?? null) as TimeEntrySnapshot | null
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const after = await loadTimeEntrySnapshot(
      em,
      result.timeEntryId,
      before ? staffSnapshotScopeFromSnapshot(before) : staffSnapshotScopeFromContext(ctx),
    )
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('staff.audit.timesheets.time_entries.startTimer', 'Start timer'),
      resourceKind: 'staff.timesheets.time_entry',
      resourceId: result.timeEntryId,
      tenantId: result.undoState.tenantId,
      organizationId: result.undoState.organizationId,
      snapshotBefore: before ?? undefined,
      snapshotAfter: after ?? undefined,
      changes: before && after
        ? buildChanges(
            before as unknown as Record<string, unknown>,
            after as unknown as Record<string, unknown>,
            ['startedAt', 'endedAt', 'source'],
          )
        : undefined,
      payload: {
        undo: {
          before: result.undoState,
        } satisfies TimeEntryStartExistingUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TimeEntryStartExistingUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scopeCtx = { tenantId: before.tenantId, organizationId: before.organizationId }

    const entry = await em.transactional(async (trx) => {
      const lockedEntry = await findOneWithDecryption(
        trx,
        StaffTimeEntry,
        { id: before.entryId, tenantId: before.tenantId, organizationId: before.organizationId, deletedAt: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
        scopeCtx,
      )
      if (!lockedEntry) return null

      // The timer was stopped after this start, so the recorded duration and
      // endedAt now depend on the very segment this undo would retire. Reverting
      // would leave an entry that ended without ever having started.
      if (lockedEntry.endedAt) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(409, {
          error: translate(
            'staff.timesheets.errors.timerAlreadyStopped',
            'Timer has already been stopped for this entry.',
          ),
        })
      }

      const segment = await findOneWithDecryption(
        trx,
        StaffTimeEntrySegment,
        {
          id: before.createdSegmentId,
          timeEntryId: before.entryId,
          tenantId: before.tenantId,
          organizationId: before.organizationId,
        },
        {},
        scopeCtx,
      )
      if (segment) {
        segment.deletedAt = new Date()
      }

      lockedEntry.startedAt = before.startedAt ? new Date(before.startedAt) : null
      lockedEntry.endedAt = before.endedAt ? new Date(before.endedAt) : null
      lockedEntry.source = before.source

      await trx.flush()
      return lockedEntry
    })

    if (!entry) return

    await emitCrudUndoSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'updated',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })
  },
}

const updateTimeEntryCommand: CommandHandler<StaffTimeEntryUpdateInput, { timeEntryId: string }> = {
  id: 'staff.timesheets.time_entries.update',
  async prepare(rawInput, ctx) {
    const parsed = staffTimeEntryUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager)
    const snapshot = await loadTimeEntrySnapshot(em, parsed.id, staffSnapshotScopeFromContext(ctx))
    if (!snapshot) return {}
    return { before: snapshot }
  },
  async execute(rawInput, ctx) {
    const parsed = staffTimeEntryUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scope = commandActorScope(ctx)
    const entry = await findOneWithDecryption(
      em,
      StaffTimeEntry,
      applyScopeToWhere<StaffTimeEntry>({ id: parsed.id, deletedAt: null }, scope),
      undefined,
      scopeForDecryption(scope),
    )
    if (!entry) throw new CrudHttpError(404, { error: 'Time entry not found.' })
    ensureTenantScope(ctx, entry.tenantId)
    ensureOrganizationScope(ctx, entry.organizationId)

    // Ownership enforcement: callers without `staff.timesheets.manage_all`
    // can only update entries they own.
    if (!(await callerHasManageAll(ctx))) {
      const callerStaffMemberId = await resolveCallerStaffMemberId(em, ctx)
      if (!callerStaffMemberId || entry.staffMemberId !== callerStaffMemberId) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(403, {
          error: translate('staff.timesheets.errors.notOwner', 'You can only manage your own time entries.'),
        })
      }
    }

    // Validate referenced timeProjectId is in-scope when it's being changed to a non-null value.
    if (parsed.timeProjectId !== undefined && parsed.timeProjectId !== null) {
      await assertTimeProjectInScope(em, parsed.timeProjectId, entry.tenantId, entry.organizationId)
    }

    if (parsed.date !== undefined) entry.date = parsed.date
    if (parsed.durationMinutes !== undefined) entry.durationMinutes = parsed.durationMinutes
    if (parsed.timeProjectId !== undefined) entry.timeProjectId = parsed.timeProjectId ?? null
    if (parsed.customerId !== undefined) entry.customerId = parsed.customerId ?? null
    if (parsed.dealId !== undefined) entry.dealId = parsed.dealId ?? null
    if (parsed.orderId !== undefined) entry.orderId = parsed.orderId ?? null
    if (parsed.notes !== undefined) entry.notes = parsed.notes ?? null
    entry.updatedAt = new Date()
    await em.flush()

    await emitCrudSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'updated',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })

    return { timeEntryId: entry.id }
  },
  buildLog: async ({ snapshots, ctx }) => {
    const before = snapshots.before as TimeEntrySnapshot | undefined
    if (!before) return null
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const after = await loadTimeEntrySnapshot(em, before.id, staffSnapshotScopeFromSnapshot(before))
    if (!after) return null
    const changes = buildChanges(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, [
      'date',
      'durationMinutes',
      'timeProjectId',
      'customerId',
      'dealId',
      'orderId',
      'notes',
      'deletedAt',
    ])
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('staff.audit.timesheets.time_entries.update', 'Update time entry'),
      resourceKind: 'staff.timesheets.time_entry',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      snapshotAfter: after,
      changes,
      payload: {
        undo: {
          before,
          after,
        } satisfies TimeEntryUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TimeEntryUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const entry = await em.findOne(StaffTimeEntry, scopedStaffSnapshotWhere(before.id, staffSnapshotScopeFromSnapshot(before)))
    if (!entry) return
    entry.date = before.date as unknown as Date
    entry.durationMinutes = before.durationMinutes
    entry.timeProjectId = before.timeProjectId ?? null
    entry.customerId = before.customerId ?? null
    entry.dealId = before.dealId ?? null
    entry.orderId = before.orderId ?? null
    entry.notes = before.notes ?? null
    // Always resolves to null, so this is not a seventh uncascaded soft-delete site:
    // `execute` only ever resolves entries with `deletedAt: null`, so a log written by
    // this command can never carry a non-null `before.deletedAt` to restore.
    entry.deletedAt = before.deletedAt ? new Date(before.deletedAt) : null
    entry.updatedAt = new Date()
    await em.flush()

    await emitCrudUndoSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'updated',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })
  },
}

/**
 * Deliberately has no `redo`, unlike `createTimeEntryCommand`. A create needs one
 * because replaying `execute` would mint a new id; a soft-delete keyed on an id the
 * redo input already carries is idempotent, so the command bus's fallback —
 * `execute(commandPayload.__redoInput)` for any handler without a `redo` — is the
 * correct replay. That path still runs `prepare` and `buildLog`, so the redo writes
 * its own action log — fresh undo token, undo payload rebuilt from the state the
 * replay actually produced — and the next undo reads that log, not the original.
 */
const deleteTimeEntryCommand: CommandHandler<{ id?: string }, { timeEntryId: string; segmentsDeletedAt: string }> = {
  id: 'staff.timesheets.time_entries.delete',
  async prepare(input, ctx) {
    const id = input?.id
    if (!id) throw new CrudHttpError(400, { error: 'Time entry id is required.' })
    const em = (ctx.container.resolve('em') as EntityManager)
    const snapshot = await loadTimeEntrySnapshot(em, id, staffSnapshotScopeFromContext(ctx))
    if (!snapshot) return {}
    return { before: snapshot }
  },
  async execute(input, ctx) {
    const id = input?.id
    if (!id) throw new CrudHttpError(400, { error: 'Time entry id is required.' })
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const scope = commandActorScope(ctx)
    const entry = await findOneWithDecryption(
      em,
      StaffTimeEntry,
      applyScopeToWhere<StaffTimeEntry>({ id, deletedAt: null }, scope),
      undefined,
      scopeForDecryption(scope),
    )
    if (!entry) throw new CrudHttpError(404, { error: 'Time entry not found.' })
    ensureTenantScope(ctx, entry.tenantId)
    ensureOrganizationScope(ctx, entry.organizationId)

    // Ownership enforcement: callers without `staff.timesheets.manage_all`
    // can only delete entries they own.
    if (!(await callerHasManageAll(ctx))) {
      const callerStaffMemberId = await resolveCallerStaffMemberId(em, ctx)
      if (!callerStaffMemberId || entry.staffMemberId !== callerStaffMemberId) {
        const { translate } = await resolveTranslations()
        throw new CrudHttpError(403, {
          error: translate('staff.timesheets.errors.notOwner', 'You can only manage your own time entries.'),
        })
      }
    }

    // The entry and every segment it owns are stamped with ONE instant, and that
    // instant is what `undo` restores on. Matching on it is what keeps undo from
    // resurrecting a segment the user had deleted individually beforehand.
    const deletedAt = new Date()
    entry.deletedAt = deletedAt
    entry.updatedAt = deletedAt
    await softDeleteSegmentsForEntry(
      em,
      entry.id,
      { tenantId: entry.tenantId, organizationId: entry.organizationId },
      deletedAt,
    )
    await em.flush()

    await emitCrudSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'deleted',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })

    return { timeEntryId: entry.id, segmentsDeletedAt: deletedAt.toISOString() }
  },
  buildLog: async ({ result, snapshots }) => {
    const before = snapshots.before as TimeEntrySnapshot | undefined
    if (!before) return null
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('staff.audit.timesheets.time_entries.delete', 'Delete time entry'),
      resourceKind: 'staff.timesheets.time_entry',
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      payload: {
        undo: {
          before,
          segmentsDeletedAt: result.segmentsDeletedAt,
        } satisfies TimeEntryUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<TimeEntryUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let entry = await em.findOne(StaffTimeEntry, scopedStaffSnapshotWhere(before.id, staffSnapshotScopeFromSnapshot(before)))
    if (!entry) {
      entry = em.create(StaffTimeEntry, {
        id: before.id,
        tenantId: before.tenantId,
        organizationId: before.organizationId,
        staffMemberId: before.staffMemberId,
        date: before.date as unknown as Date,
        durationMinutes: before.durationMinutes,
        startedAt: before.startedAt ? new Date(before.startedAt) : null,
        endedAt: before.endedAt ? new Date(before.endedAt) : null,
        notes: before.notes ?? null,
        timeProjectId: before.timeProjectId ?? null,
        customerId: before.customerId ?? null,
        dealId: before.dealId ?? null,
        orderId: before.orderId ?? null,
        source: (before.source ?? 'manual') as StaffTimeEntrySource,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      em.persist(entry)
    } else {
      entry.staffMemberId = before.staffMemberId
      entry.date = before.date as unknown as Date
      entry.durationMinutes = before.durationMinutes
      entry.startedAt = before.startedAt ? new Date(before.startedAt) : null
      entry.endedAt = before.endedAt ? new Date(before.endedAt) : null
      entry.notes = before.notes ?? null
      entry.timeProjectId = before.timeProjectId ?? null
      entry.customerId = before.customerId ?? null
      entry.dealId = before.dealId ?? null
      entry.orderId = before.orderId ?? null
      entry.source = (before.source ?? 'manual') as StaffTimeEntrySource
      entry.deletedAt = null
      entry.updatedAt = new Date()
    }

    // Absent on logs written before the cascade existed. Those deletes never
    // touched segments, so restoring none is the correct outcome, not a fallback.
    if (payload?.segmentsDeletedAt) {
      await restoreSegmentsForEntry(
        em,
        before.id,
        { tenantId: before.tenantId, organizationId: before.organizationId },
        new Date(payload.segmentsDeletedAt),
      )
    }

    await em.flush()

    await emitCrudUndoSideEffects({
      dataEngine: ctx.container.resolve('dataEngine'),
      action: 'created',
      entity: entry,
      identifiers: { id: entry.id, organizationId: entry.organizationId, tenantId: entry.tenantId },
      events: staffTimeEntryCrudEvents,
      indexer: timeEntryCrudIndexer,
    })
  },
}

registerCommand(createTimeEntryCommand)
registerCommand(startTimerCommand)
registerCommand(stopTimerCommand)
registerCommand(startTimerExistingCommand)
registerCommand(updateTimeEntryCommand)
registerCommand(deleteTimeEntryCommand)
