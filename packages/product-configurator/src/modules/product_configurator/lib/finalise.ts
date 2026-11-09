import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { ConfigurationSessionStatus } from '../data/entities'
import type { ConfigurationResult } from './evaluation'
import type { QuoteHeader } from './quoteAccess'

export type FinaliseSession = {
  id: string
  tenantId: string
  organizationId: string
  quoteId: string
  modelVersionId: string
  revision: number
  status: ConfigurationSessionStatus
  selections: Record<string, unknown>
  evaluation?: Record<string, unknown> | null
  migration?: Record<string, unknown> | null
}

export type FinaliseSnapshot = {
  id: string
  sessionId: string
  quoteId: string
  quoteLineId?: string | null
  modelVersionId: string
  hash: string
}

/** What finalise needs from step 3 to write the snapshot and the line. */
export type PreparedFinalise = {
  result: ConfigurationResult
  modelVersionHash: string
  modelTitle: string
  productId: string
  taxRateId: string | null
}

export type ConfiguredLineBody = {
  organizationId: string
  tenantId: string
  quoteId: string
  productId: string
  name: string
  description: string
  quantity: number
  currencyCode: string
  unitPriceNet: string
  priceMode: 'net'
  taxRateId?: string
  configuration: { productConfigurator: { snapshotId: string; modelVersionId: string; hash: string; summary: string } }
}

export type TransitionResult =
  | { ok: true; session: FinaliseSession }
  | { ok: false; session: FinaliseSession | null }

export type SessionPage = { afterId: string | null; limit: number }

/** The module's own rows. Every method runs its own short transaction with the session row locked. */
export type FinaliseStore = {
  findSession(id: string): Promise<FinaliseSession | null>
  /** Sessions in progress of the quote ordered by id, `limit` at a time after `afterId`. */
  listInProgressSessions(quoteId: string, page: SessionPage): Promise<FinaliseSession[]>
  transition(id: string, from: readonly ConfigurationSessionStatus[], to: ConfigurationSessionStatus): Promise<TransitionResult>
  findSnapshot(sessionId: string): Promise<FinaliseSnapshot | null>
  /**
   * Inserts the snapshot, replacing an unlinked one of the session, and stores its result as the session's
   * evaluation, so a later finalise from the stored session confirms what is being added. Refuses unless the session is `finalising`.
   */
  writeSnapshot(session: FinaliseSession, prepared: PreparedFinalise): Promise<FinaliseSnapshot>
  /** Links the snapshot to the line (when not linked yet) and moves the session from `from` to `finalised`. */
  complete(sessionId: string, snapshotId: string, quoteLineId: string, from: readonly ConfigurationSessionStatus[]): Promise<boolean>
}

export type FinaliseSales = {
  readQuote(quoteId: string): Promise<QuoteHeader | null>
  findLineCarrying(kind: 'quote' | 'order', parentId: string, snapshotId: string): Promise<string | null>
  /** Dispatches the trusted `sales.quotes.lines.upsert`; returns the new line id. */
  writeLine(body: ConfiguredLineBody, quoteUpdatedAt: string | null): Promise<string>
}

export type HeldQuoteLock = {
  /** Throws when the lock connection is gone, so finalise stops before its next write. */
  assertHeld(): Promise<void>
}

/** Not acquired: `held` when another finalise holds this quote, `busy` when no lock connection freed up in time. */
export type QuoteLockOutcome<T> = { acquired: true; value: T } | { acquired: false; reason: 'held' | 'busy' }

export type QuoteLockPort = {
  withLock<T>(quoteId: string, run: (lock: HeldQuoteLock) => Promise<T>): Promise<QuoteLockOutcome<T>>
}

export type SnapshotCreatedPayload = {
  snapshotId: string
  sessionId: string
  modelVersionId: string
  quoteId: string
  quoteLineId: string
  hash: string
  tenantId: string
  organizationId: string
}

export type FinaliseObserver = {
  snapshotCreated(payload: SnapshotCreatedPayload): Promise<void>
  failed(stage: string, error: unknown, context: Record<string, unknown>): void
  outcome(code: string, context: Record<string, unknown>): void
}

export type FinaliseDeps = {
  lock: QuoteLockPort
  store: FinaliseStore
  sales: FinaliseSales
  /** Step 3 after the revision check: model, bound product, currency and the re-evaluation. Throws to refuse. */
  prepare(session: FinaliseSession, quote: QuoteHeader): Promise<PreparedFinalise>
  observer: FinaliseObserver
}

export type FinaliseInput = { id: string; expectedHash: string; revision: number; migrationAcknowledged?: boolean }

/**
 * `added_with_earlier_choices`: the session was finalised with a line an earlier attempt already
 * committed, whose result differs from the one the rep confirmed (`expectedHash`); later changes were not added.
 */
export type FinaliseOutcome = 'added' | 'added_with_earlier_choices'

export type FinaliseResult = { snapshotId: string; quoteLineId: string; hash: string; replay: boolean; outcome: FinaliseOutcome }

export type FinaliseFailureCode =
  | 'session_not_found'
  | 'session_not_open'
  | 'finalise_in_progress'
  | 'finalise_busy'
  | 'session_changed'
  | 'migration_unconfirmed'
  | 'not_finalisable'
  | 'result_changed'
  | 'quote_changed'
  | 'quote_converted'
  | 'quote_line_write_failed'

/** A refused finalise. `details` carries what the client needs (`status`, `session`, `result`). */
export class FinaliseFailure extends Error {
  readonly code: FinaliseFailureCode
  readonly details: Record<string, unknown>

  constructor(code: FinaliseFailureCode, details: Record<string, unknown> = {}) {
    super(`[internal] product_configurator finalise refused: ${code}`)
    this.name = 'FinaliseFailure'
    this.code = code
    this.details = details
  }
}

const CLAIMABLE: readonly ConfigurationSessionStatus[] = ['open', 'finalising']
const FINALISING: readonly ConfigurationSessionStatus[] = ['finalising']

function sessionState(session: FinaliseSession): Record<string, unknown> {
  return {
    id: session.id,
    status: session.status,
    revision: session.revision,
    selections: session.selections,
    evaluation: session.evaluation ?? null,
  }
}

function hasMigrationItems(migration: Record<string, unknown> | null | undefined): boolean {
  if (!migration) return false
  return ['kept', 'dropped', 'reset'].some((key) => {
    const items = migration[key]
    return Array.isArray(items) && items.length > 0
  })
}

function outcomeFor(addedHash: string, input: FinaliseInput): FinaliseOutcome {
  return addedHash === input.expectedHash ? 'added' : 'added_with_earlier_choices'
}

async function replayOf(store: FinaliseStore, session: FinaliseSession, input: FinaliseInput): Promise<FinaliseResult> {
  const snapshot = await store.findSnapshot(session.id)
  if (!snapshot?.quoteLineId) throw new FinaliseFailure('session_not_open', { status: session.status })
  return { snapshotId: snapshot.id, quoteLineId: snapshot.quoteLineId, hash: snapshot.hash, replay: true, outcome: outcomeFor(snapshot.hash, input) }
}

async function completeFinalise(
  deps: FinaliseDeps,
  session: FinaliseSession,
  snapshot: FinaliseSnapshot,
  quoteLineId: string,
  from: readonly ConfigurationSessionStatus[],
  outcome: FinaliseOutcome = 'added',
): Promise<FinaliseResult | null> {
  const completed = await deps.store.complete(session.id, snapshot.id, quoteLineId, from)
  if (!completed) return null
  await deps.observer.snapshotCreated({
    snapshotId: snapshot.id,
    sessionId: session.id,
    modelVersionId: snapshot.modelVersionId,
    quoteId: session.quoteId,
    quoteLineId,
    hash: snapshot.hash,
    tenantId: session.tenantId,
    organizationId: session.organizationId,
  })
  return { snapshotId: snapshot.id, quoteLineId, hash: snapshot.hash, replay: false, outcome }
}

/** Where the line carrying a snapshot was committed, and whether the quote is still there. */
type CommittedLine = { lineId: string | null; quoteExists: boolean }

/**
 * A committed line carrying the snapshot, on the quote or, when the quote is gone, on the order the
 * conversion created with the quote's id. Never re-evaluates.
 */
async function findCommittedLine(deps: FinaliseDeps, session: FinaliseSession, snapshotId: string): Promise<CommittedLine> {
  const onQuote = await deps.sales.findLineCarrying('quote', session.quoteId, snapshotId)
  if (onQuote) return { lineId: onQuote, quoteExists: true }
  if (await deps.sales.readQuote(session.quoteId)) return { lineId: null, quoteExists: true }
  return { lineId: await deps.sales.findLineCarrying('order', session.quoteId, snapshotId), quoteExists: false }
}

function errorStatus(error: unknown): number | null {
  if (isCrudHttpError(error)) return error.status
  return getCommandInterceptorHttpRejection(error)?.status ?? null
}

async function releaseAndThrow(deps: FinaliseDeps, sessionId: string, to: 'open' | 'cancelled', failure: unknown): Promise<never> {
  await deps.store.transition(sessionId, FINALISING, to)
  throw failure
}

/**
 * The sales command can fail after its transaction committed (post-commit work, `afterExecute`
 * interceptors, events, audit), so a failed write is reconciled against the committed lines before
 * the session is reopened or cancelled. A committed line is adopted; when the lines cannot be read,
 * the outcome is unknown and the session stays `finalising` for the next call to reconcile.
 */
async function reconcileFailedWrite(
  deps: FinaliseDeps,
  session: FinaliseSession,
  snapshot: FinaliseSnapshot,
  error: unknown,
): Promise<string> {
  const context = { sessionId: session.id, quoteId: session.quoteId, snapshotId: snapshot.id }
  let committed: CommittedLine
  try {
    committed = await findCommittedLine(deps, session, snapshot.id)
  } catch (readError) {
    deps.observer.failed('line_write', error, context)
    deps.observer.failed('line_reconcile', readError, context)
    throw new FinaliseFailure('quote_line_write_failed', { status: 'finalising' })
  }
  if (committed.lineId) {
    deps.observer.failed('line_write_after_commit', error, { ...context, quoteLineId: committed.lineId })
    return committed.lineId
  }
  const status = errorStatus(error)
  if (!committed.quoteExists) {
    deps.observer.outcome('quote_converted', context)
    return releaseAndThrow(deps, session.id, 'cancelled', new FinaliseFailure('quote_converted'))
  }
  if (status === 409) {
    deps.observer.outcome('quote_changed', context)
    return releaseAndThrow(deps, session.id, 'open', new FinaliseFailure('quote_changed'))
  }
  deps.observer.failed('line_write', error, context)
  return releaseAndThrow(deps, session.id, 'open', new FinaliseFailure('quote_line_write_failed', { status: 'open' }))
}

async function writeConfiguredLine(
  deps: FinaliseDeps,
  session: FinaliseSession,
  quote: QuoteHeader,
  prepared: PreparedFinalise,
  snapshot: FinaliseSnapshot,
): Promise<string> {
  const { result } = prepared
  const body: ConfiguredLineBody = {
    organizationId: session.organizationId,
    tenantId: session.tenantId,
    quoteId: session.quoteId,
    productId: prepared.productId,
    name: prepared.modelTitle,
    description: result.summary,
    quantity: 1,
    currencyCode: result.currencyCode,
    unitPriceNet: result.netPrice,
    priceMode: 'net',
    ...(prepared.taxRateId ? { taxRateId: prepared.taxRateId } : {}),
    configuration: {
      productConfigurator: { snapshotId: snapshot.id, modelVersionId: session.modelVersionId, hash: result.hash, summary: result.summary },
    },
  }
  try {
    return await deps.sales.writeLine(body, quote.updatedAt)
  } catch (error) {
    return reconcileFailedWrite(deps, session, snapshot, error)
  }
}

/** Steps 3 to 6, run with the quote lock held and the session claimed as `finalising`. */
async function evaluateAndWrite(
  deps: FinaliseDeps,
  lock: HeldQuoteLock,
  session: FinaliseSession,
  input: FinaliseInput,
): Promise<FinaliseResult> {
  let quote: QuoteHeader
  let prepared: PreparedFinalise
  try {
    const current = await deps.sales.readQuote(session.quoteId)
    if (!current) {
      deps.observer.outcome('quote_converted', { sessionId: session.id, quoteId: session.quoteId })
      return await releaseAndThrow(deps, session.id, 'cancelled', new FinaliseFailure('quote_converted'))
    }
    quote = current
    if (session.revision !== input.revision) {
      throw new FinaliseFailure('session_changed', { session: sessionState({ ...session, status: 'open' }) })
    }
    if (hasMigrationItems(session.migration) && input.migrationAcknowledged !== true) {
      throw new FinaliseFailure('migration_unconfirmed', { migration: session.migration })
    }
    prepared = await deps.prepare(session, quote)
    if (!prepared.result.finalisable) throw new FinaliseFailure('not_finalisable', { result: prepared.result })
    if (prepared.result.hash !== input.expectedHash) throw new FinaliseFailure('result_changed', { result: prepared.result })
  } catch (error) {
    if (error instanceof FinaliseFailure && error.code === 'quote_converted') throw error
    return releaseAndThrow(deps, session.id, 'open', error)
  }

  const context = { sessionId: session.id, quoteId: session.quoteId }
  await assertLockHeld(deps, lock, context)
  let snapshot: FinaliseSnapshot
  try {
    snapshot = await deps.store.writeSnapshot(session, prepared)
  } catch (error) {
    deps.observer.failed('snapshot_write', error, context)
    return releaseAndThrow(deps, session.id, 'open', error)
  }
  await assertLockHeld(deps, lock, context)
  const quoteLineId = await writeConfiguredLine(deps, session, quote, prepared, snapshot)
  await assertLockHeld(deps, lock, context)
  try {
    const completed = await completeFinalise(deps, session, snapshot, quoteLineId, FINALISING)
    if (completed) return completed
  } catch (error) {
    deps.observer.failed('complete', error, { ...context, snapshotId: snapshot.id, quoteLineId })
    throw error
  }
  throw new FinaliseFailure('session_not_open', { status: (await deps.store.findSession(session.id))?.status ?? null })
}

/** A lost lock connection stops finalise before its next write; the session stays `finalising` for the next call to reconcile. */
async function assertLockHeld(deps: FinaliseDeps, lock: HeldQuoteLock, context: Record<string, unknown>): Promise<void> {
  try {
    await lock.assertHeld()
  } catch (error) {
    deps.observer.failed('lock_lost', error, context)
    throw error
  }
}

/**
 * A cancelled session of a quote that no longer exists was cancelled by the conversion cleanup (or
 * its quote was deleted later): `quote_converted` tells the rep why it can never finish.
 */
async function notOpen(deps: FinaliseDeps, session: FinaliseSession): Promise<FinaliseFailure> {
  if (session.status === 'cancelled' && !(await deps.sales.readQuote(session.quoteId))) {
    return new FinaliseFailure('quote_converted')
  }
  return new FinaliseFailure('session_not_open', { status: session.status })
}

/**
 * Finalises a session into a quote line (spec "Session flow"). Serialized per quote by the advisory
 * lock; recovery adopts a committed line before anything is re-evaluated, so a retry after a crash
 * between the sales commit and storing `quote_line_id` never writes a second line or a new price.
 */
export async function finaliseSession(deps: FinaliseDeps, input: FinaliseInput): Promise<FinaliseResult> {
  const initial = await deps.store.findSession(input.id)
  if (!initial) throw new FinaliseFailure('session_not_found')
  if (initial.status === 'finalised') return replayOf(deps.store, initial, input)
  if (initial.status === 'cancelled') throw await notOpen(deps, initial)

  const outcome = await deps.lock.withLock(initial.quoteId, async (lock) => {
    const claimed = await deps.store.transition(input.id, CLAIMABLE, 'finalising')
    if (!claimed.ok) {
      if (!claimed.session) throw new FinaliseFailure('session_not_found')
      if (claimed.session.status === 'finalised') return replayOf(deps.store, claimed.session, input)
      throw await notOpen(deps, claimed.session)
    }
    const session = claimed.session

    const existing = await deps.store.findSnapshot(session.id)
    if (existing?.quoteLineId) {
      const completed = await completeFinalise(deps, session, existing, existing.quoteLineId, FINALISING, outcomeFor(existing.hash, input))
      if (completed) return completed
    } else if (existing) {
      const { lineId } = await findCommittedLine(deps, session, existing.id)
      if (lineId) {
        deps.observer.outcome('adopted', { sessionId: session.id, snapshotId: existing.id, quoteLineId: lineId })
        await assertLockHeld(deps, lock, { sessionId: session.id, quoteId: session.quoteId })
        const completed = await completeFinalise(deps, session, existing, lineId, FINALISING, outcomeFor(existing.hash, input))
        if (completed) return completed
      }
    }
    return evaluateAndWrite(deps, lock, session, input)
  })
  if (!outcome.acquired) throw new FinaliseFailure(outcome.reason === 'busy' ? 'finalise_busy' : 'finalise_in_progress')
  return outcome.value
}

export type ConvertedQuoteInput = { quoteId: string; orderId: string }

export type ConvertedQuoteReport = { finalised: string[]; cancelled: string[]; skipped: string[] }

export const RECONCILE_BATCH_SIZE = 100

/** Visits every session in progress of the quote, a batch at a time, starting with `first`. */
async function forEachInProgressSession(
  deps: FinaliseDeps,
  quoteId: string,
  first: FinaliseSession[],
  visit: (session: FinaliseSession) => Promise<void>,
): Promise<void> {
  let batch = first
  for (;;) {
    for (const session of batch) await visit(session)
    if (batch.length < RECONCILE_BATCH_SIZE) return
    batch = await deps.store.listInProgressSessions(quoteId, { afterId: batch[batch.length - 1].id, limit: RECONCILE_BATCH_SIZE })
  }
}

/**
 * Cleanup after `sales.quotes.convert_to_order`. With the quote lock free, every session in progress
 * is reconciled against the order lines (a line carrying its snapshot -> adopted and finalised) or
 * cancelled. With the lock busy, a running finalise ends its own session, so only open sessions with
 * no snapshot are cancelled. Idempotent: every change is a compare-and-set on the session status.
 */
export async function reconcileConvertedQuote(deps: FinaliseDeps, input: ConvertedQuoteInput): Promise<ConvertedQuoteReport> {
  const report: ConvertedQuoteReport = { finalised: [], cancelled: [], skipped: [] }
  const first = await deps.store.listInProgressSessions(input.quoteId, { afterId: null, limit: RECONCILE_BATCH_SIZE })
  if (!first.length) return report

  const outcome = await deps.lock.withLock(input.quoteId, async (lock) => {
    await forEachInProgressSession(deps, input.quoteId, first, async (session) => {
      const snapshot = await deps.store.findSnapshot(session.id)
      const lineId = snapshot
        ? (snapshot.quoteLineId ?? (await deps.sales.findLineCarrying('order', input.orderId, snapshot.id)))
        : null
      await assertLockHeld(deps, lock, { sessionId: session.id, quoteId: input.quoteId })
      if (snapshot && lineId) {
        const completed = await completeFinalise(deps, session, snapshot, lineId, CLAIMABLE)
        ;(completed ? report.finalised : report.skipped).push(session.id)
        return
      }
      const cancelled = await deps.store.transition(session.id, CLAIMABLE, 'cancelled')
      ;(cancelled.ok ? report.cancelled : report.skipped).push(session.id)
    })
  })
  if (outcome.acquired) return report

  await forEachInProgressSession(deps, input.quoteId, first, async (session) => {
    const snapshot = session.status === 'open' ? await deps.store.findSnapshot(session.id) : null
    if (session.status !== 'open' || snapshot) {
      report.skipped.push(session.id)
      return
    }
    const cancelled = await deps.store.transition(session.id, ['open'], 'cancelled')
    ;(cancelled.ok ? report.cancelled : report.skipped).push(session.id)
  })
  return report
}
