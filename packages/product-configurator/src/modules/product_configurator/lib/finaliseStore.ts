import { LockMode, type Dictionary } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { ConfigurationSession, ConfigurationSnapshot, type ConfigurationSessionStatus } from '../data/entities'
import { SESSION_IN_PROGRESS_STATUSES } from '../data/validators'
import type { FinaliseSession, FinaliseSnapshot, FinaliseStore, HeldQuoteLock, PreparedFinalise, QuoteLockPort, TransitionResult } from './finalise'
import type { QuoteScope } from './quoteAccess'

export function quoteLockKey(quoteId: string): string {
  return `product_configurator:quote:${quoteId}`
}

const logger = createLogger('product_configurator.finalise')

function reportLockCleanupFailure(error: unknown, quoteId: string): void {
  logger.error('Quote lock cleanup failed', { quoteId, err: error })
  getTelemetryRuntime()?.reportError(error, { module: 'product_configurator', code: 'product_configurator.finalise_lock_cleanup_failed' })
}

/** The pg pool client surface the lock uses; `pg` is reached through the ORM driver, not imported. */
type LockClient = {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  release(destroy?: boolean): void
}

type LockPool = { connect(): Promise<LockClient> }

type LockSlots = { pool: LockPool; busy: number; waiting: Array<() => void> }

/** Quote locks held at once per process; finalise holds one for well under a second. */
export const QUOTE_LOCK_CONNECTIONS = 4

/** How long a finalise waits for a free lock connection before answering `finalise_busy`. */
export const QUOTE_LOCK_WAIT_MS = 2_000

const LOCK_POOLS_KEY = '__openMercatoProductConfiguratorQuoteLockPools__'

/** Kept on `globalThis` so duplicated module instances in one process (dev HMR, server chunks) share the pools. */
function lockPools(): WeakMap<object, LockSlots> {
  const holder = globalThis as Record<string, unknown>
  const existing = holder[LOCK_POOLS_KEY]
  if (existing instanceof WeakMap) return existing as WeakMap<object, LockSlots>
  const created = new WeakMap<object, LockSlots>()
  holder[LOCK_POOLS_KEY] = created
  return created
}

/**
 * One small pool per ORM configuration (so one per process), outside the app pool and built from the
 * ORM's own connection options: a held lock never pins an app pool connection, and finalises never
 * open more than `QUOTE_LOCK_CONNECTIONS` lock connections. Idle connections do not keep the process alive.
 */
function lockSlots(em: EntityManager): LockSlots {
  const pools = lockPools()
  const existing = pools.get(em.config)
  if (existing) return existing
  const created: { pool?: LockPool } = {}
  const options: Dictionary = {
    ...(em.config.get('driverOptions') ?? {}),
    min: 0,
    max: QUOTE_LOCK_CONNECTIONS,
    allowExitOnIdle: true,
    onPoolCreated: (pool: LockPool) => {
      created.pool = pool
    },
  }
  em.getConnection().createKyselyDialect(options)
  if (!created.pool) throw new Error('[internal] product_configurator: the quote lock pool was not created')
  const slots: LockSlots = { pool: created.pool, busy: 0, waiting: [] }
  pools.set(em.config, slots)
  return slots
}

/** Takes a lock connection slot, waiting up to `QUOTE_LOCK_WAIT_MS`; false when none frees up. */
function takeSlot(slots: LockSlots): Promise<boolean> {
  if (slots.busy < QUOTE_LOCK_CONNECTIONS) {
    slots.busy += 1
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const granted = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      slots.waiting.splice(slots.waiting.indexOf(granted), 1)
      resolve(false)
    }, QUOTE_LOCK_WAIT_MS)
    slots.waiting.push(granted)
  })
}

/** Hands the slot to the next waiter, or frees it. */
function releaseSlot(slots: LockSlots): void {
  const next = slots.waiting.shift()
  if (next) next()
  else slots.busy -= 1
}

const TRY_LOCK_SQL = 'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked'
const UNLOCK_SQL = 'select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked'

/**
 * Per-quote, session-level advisory lock on a connection of the lock pool (see `lockSlots`). A dead
 * process closes its connection and PostgreSQL releases the lock, so there is no time-based takeover.
 * The connection must be direct, never a transaction-mode pooler, which silently drops session-level
 * locks. A connection whose unlock failed is destroyed, never reused, so it cannot keep the lock.
 * Unlock and release failures are reported and never replace the result or error of `run`. No free
 * lock connection within `QUOTE_LOCK_WAIT_MS` answers `busy`, which is not about this quote.
 */
export function createQuoteLock(em: EntityManager): QuoteLockPort {
  return {
    async withLock(quoteId, run) {
      const key = quoteLockKey(quoteId)
      const slots = lockSlots(em)
      if (!(await takeSlot(slots))) return { acquired: false as const, reason: 'busy' as const }
      try {
        const client = await slots.pool.connect()
        let destroy = false
        try {
          const locked = await client.query(TRY_LOCK_SQL, [key]).catch((error: unknown) => {
            destroy = true
            throw error
          })
          if (locked.rows[0]?.locked !== true) return { acquired: false as const, reason: 'held' as const }
          const held: HeldQuoteLock = {
            async assertHeld() {
              await client.query('select 1 as alive', [])
            },
          }
          try {
            return { acquired: true as const, value: await run(held) }
          } finally {
            await client.query(UNLOCK_SQL, [key]).catch((error: unknown) => {
              destroy = true
              reportLockCleanupFailure(error, quoteId)
            })
          }
        } finally {
          try {
            client.release(destroy)
          } catch (error) {
            reportLockCleanupFailure(error, quoteId)
          }
        }
      } finally {
        releaseSlot(slots)
      }
    },
  }
}

function toFinaliseSession(session: ConfigurationSession): FinaliseSession {
  return {
    id: session.id,
    tenantId: session.tenantId,
    organizationId: session.organizationId,
    quoteId: session.quoteId,
    modelVersionId: session.modelVersionId,
    revision: session.revision,
    status: session.status,
    selections: session.selections,
    evaluation: session.evaluation ?? null,
    migration: session.migration ?? null,
  }
}

function toFinaliseSnapshot(snapshot: ConfigurationSnapshot): FinaliseSnapshot {
  return {
    id: snapshot.id,
    sessionId: snapshot.sessionId,
    quoteId: snapshot.quoteId,
    quoteLineId: snapshot.quoteLineId ?? null,
    modelVersionId: snapshot.modelVersionId,
    hash: snapshot.hash,
  }
}

async function lockSession(trx: EntityManager, id: string, scope: QuoteScope): Promise<ConfigurationSession | null> {
  return findOneWithDecryption(
    trx,
    ConfigurationSession,
    { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    scope,
  )
}

async function findSnapshotRow(em: EntityManager, sessionId: string, scope: QuoteScope): Promise<ConfigurationSnapshot | null> {
  return findOneWithDecryption(
    em,
    ConfigurationSnapshot,
    { sessionId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    { refresh: true },
    scope,
  )
}

/** The settled selections and visibility the snapshot read model renders; `intent` is what a copy starts from. */
export function snapshotSelections(session: FinaliseSession, prepared: PreparedFinalise): Record<string, unknown> {
  return {
    intent: session.selections,
    settled: prepared.result.selections,
    visibility: prepared.result.visibility,
  }
}

/** The module's own session and snapshot rows in one organization. Each call runs in its own transaction. */
export function createFinaliseStore(em: EntityManager, scope: QuoteScope): FinaliseStore {
  return {
    async findSession(id) {
      const session = await findOneWithDecryption(
        em.fork(),
        ConfigurationSession,
        { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
        undefined,
        scope,
      )
      return session ? toFinaliseSession(session) : null
    },

    async listInProgressSessions(quoteId, page) {
      const sessions = await findWithDecryption(
        em.fork(),
        ConfigurationSession,
        {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          quoteId,
          status: { $in: [...SESSION_IN_PROGRESS_STATUSES] },
          ...(page.afterId ? { id: { $gt: page.afterId } } : {}),
        },
        { orderBy: { id: 'asc' }, limit: page.limit },
        scope,
      )
      return sessions.map(toFinaliseSession)
    },

    async transition(id, from, to): Promise<TransitionResult> {
      return em.fork().transactional(async (trx) => {
        const locked = await lockSession(trx, id, scope)
        if (!locked) return { ok: false, session: null }
        if (!from.includes(locked.status)) return { ok: false, session: toFinaliseSession(locked) }
        locked.status = to
        await trx.flush()
        return { ok: true, session: toFinaliseSession(locked) }
      })
    },

    async findSnapshot(sessionId) {
      const snapshot = await findSnapshotRow(em.fork(), sessionId, scope)
      return snapshot ? toFinaliseSnapshot(snapshot) : null
    },

    async writeSnapshot(session, prepared) {
      return em.fork().transactional(async (trx) => {
        const locked = await lockSession(trx, session.id, scope)
        if (locked?.status !== 'finalising') throw new Error('[internal] product_configurator: snapshot written for a session that is not finalising')
        const previous = await findSnapshotRow(trx, session.id, scope)
        if (previous?.quoteLineId) throw new Error('[internal] product_configurator: linked snapshot cannot be replaced')
        if (previous) {
          trx.remove(previous)
          await trx.flush()
        }
        const { result } = prepared
        const snapshot = trx.create(ConfigurationSnapshot, {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          modelVersionId: session.modelVersionId,
          modelVersionHash: prepared.modelVersionHash,
          sessionId: session.id,
          quoteId: session.quoteId,
          quoteLineId: null,
          selections: snapshotSelections(session, prepared),
          calculated: result.calculated,
          bom: result.bom,
          warnings: result.warnings,
          priceContext: result.priceContext,
          netPrice: result.netPrice,
          currencyCode: result.currencyCode,
          summary: result.summary,
          hash: result.hash,
        })
        trx.persist(snapshot)
        locked.evaluation = result
        await trx.flush()
        return toFinaliseSnapshot(snapshot)
      })
    },

    async complete(sessionId, snapshotId, quoteLineId, from: readonly ConfigurationSessionStatus[]) {
      return em.fork().transactional(async (trx) => {
        const locked = await lockSession(trx, sessionId, scope)
        if (!locked || !from.includes(locked.status)) return false
        const snapshot = await findSnapshotRow(trx, sessionId, scope)
        if (!snapshot || snapshot.id !== snapshotId) return false
        if (!snapshot.quoteLineId) snapshot.quoteLineId = quoteLineId
        locked.status = 'finalised'
        await trx.flush()
        return true
      })
    },
  }
}
