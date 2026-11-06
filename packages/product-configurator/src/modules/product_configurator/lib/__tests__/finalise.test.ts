/** @jest-environment node */
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import type { ConfigurationSessionStatus } from '../../data/entities'
import type { ConfigurationResult } from '../evaluation'
import {
  FinaliseFailure,
  finaliseSession,
  reconcileConvertedQuote,
  RECONCILE_BATCH_SIZE,
  type ConfiguredLineBody,
  type FinaliseDeps,
  type FinaliseSession,
  type FinaliseSnapshot,
  type FinaliseStore,
  type PreparedFinalise,
  type QuoteLockPort,
  type SnapshotCreatedPayload,
} from '../finalise'
import type { QuoteHeader } from '../quoteAccess'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const SESSION_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_SESSION_ID = '55555555-5555-4555-8555-555555555555'
const VERSION_ID = '66666666-6666-4666-8666-666666666666'
const PRODUCT_ID = '77777777-7777-4777-8777-777777777777'
const TAX_RATE_ID = '88888888-8888-4888-8888-888888888888'
const HASH = 'a'.repeat(64)
const NEW_HASH = 'b'.repeat(64)

function result(overrides: Partial<ConfigurationResult> = {}): ConfigurationResult {
  return {
    modelVersionId: VERSION_ID,
    modelVersionHash: 'f'.repeat(64),
    currencyCode: 'EUR',
    priceKindId: '99999999-9999-4999-8999-999999999999',
    selections: { size: 's' },
    visibility: { size: true },
    forced: [],
    calculated: {},
    bom: [],
    availability: {},
    errors: [],
    warnings: [],
    surcharges: [],
    finalisable: true,
    currencyExponent: 2,
    netPrice: '100.00',
    hash: HASH,
    summary: 'Size: Small',
    priceContext: {
      currencyCode: 'EUR',
      priceKindId: '99999999-9999-4999-8999-999999999999',
      allowPromotions: false,
      channelId: null,
      customerId: null,
      customerIds: [],
      customerGroupIds: [],
      date: '2026-11-06T10:00:00.000Z',
    },
    evaluatedAt: '2026-11-06T10:00:00.000Z',
    ...overrides,
  }
}

function prepared(overrides: Partial<ConfigurationResult> = {}, taxRateId: string | null = TAX_RATE_ID): PreparedFinalise {
  return { result: result(overrides), modelVersionHash: 'f'.repeat(64), modelTitle: 'Pump', productId: PRODUCT_ID, taxRateId }
}

function quote(updatedAt = '2026-11-06T09:00:00.000Z'): QuoteHeader {
  return {
    id: QUOTE_ID,
    organizationId: ORG_ID,
    quoteNumber: 'Q-1',
    status: 'draft',
    currencyCode: 'EUR',
    channelId: null,
    customerEntityId: null,
    customerName: null,
    updatedAt,
  }
}

type StoredLine = { id: string; body: ConfiguredLineBody }

/** In-memory quote, order and module rows with the same compare-and-set semantics as the real store. */
class World {
  sessions = new Map<string, FinaliseSession>()
  snapshots = new Map<string, FinaliseSnapshot>()
  quoteLines: StoredLine[] = []
  orderLines: StoredLine[] = []
  quoteExists = true
  lockHeld = false
  lockBusy = false
  lockLost = false
  events: SnapshotCreatedPayload[] = []
  failures: string[] = []
  writes: ConfiguredLineBody[] = []
  lockHeaders: Array<string | null> = []
  listCalls = 0
  lineReadFailure: Error | null = null
  prepare = jest.fn(async (): Promise<PreparedFinalise> => prepared())
  writeLine = jest.fn(async (body: ConfiguredLineBody, updatedAt: string | null): Promise<string> => this.commitLine(body, updatedAt))
  private lineCounter = 0
  private snapshotCounter = 0

  addSession(overrides: Partial<FinaliseSession> = {}): FinaliseSession {
    const session: FinaliseSession = {
      id: SESSION_ID,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      quoteId: QUOTE_ID,
      modelVersionId: VERSION_ID,
      revision: 3,
      status: 'open',
      selections: { size: 's' },
      evaluation: null,
      migration: null,
      ...overrides,
    }
    this.sessions.set(session.id, session)
    return session
  }

  commitLine(body: ConfiguredLineBody, updatedAt: string | null): string {
    this.lineCounter += 1
    const id = `line-${this.lineCounter}`
    this.quoteLines.push({ id, body })
    this.writes.push(body)
    this.lockHeaders.push(updatedAt)
    return id
  }

  convert(): void {
    this.orderLines.push(...this.quoteLines)
    this.quoteLines = []
    this.quoteExists = false
  }

  status(id = SESSION_ID): ConfigurationSessionStatus | undefined {
    return this.sessions.get(id)?.status
  }

  snapshotOf(sessionId = SESSION_ID): FinaliseSnapshot | undefined {
    return [...this.snapshots.values()].find((snapshot) => snapshot.sessionId === sessionId)
  }

  store(): FinaliseStore {
    return {
      findSession: async (id) => (this.sessions.has(id) ? { ...this.sessions.get(id)! } : null),
      listInProgressSessions: async (quoteId, page) => {
        this.listCalls += 1
        return [...this.sessions.values()]
          .filter((session) => session.quoteId === quoteId && ['open', 'finalising'].includes(session.status))
          .filter((session) => page.afterId === null || session.id > page.afterId)
          .sort((left, right) => (left.id < right.id ? -1 : 1))
          .slice(0, page.limit)
          .map((session) => ({ ...session }))
      },
      transition: async (id, from, to) => {
        const session = this.sessions.get(id)
        if (!session) return { ok: false, session: null }
        if (!from.includes(session.status)) return { ok: false, session: { ...session } }
        session.status = to
        return { ok: true, session: { ...session } }
      },
      findSnapshot: async (sessionId) => {
        const snapshot = this.snapshotOf(sessionId)
        return snapshot ? { ...snapshot } : null
      },
      writeSnapshot: async (session, data) => {
        if (this.sessions.get(session.id)?.status !== 'finalising') throw new Error('not finalising')
        const previous = this.snapshotOf(session.id)
        if (previous?.quoteLineId) throw new Error('linked')
        if (previous) this.snapshots.delete(previous.id)
        this.snapshotCounter += 1
        const snapshot: FinaliseSnapshot = {
          id: `snapshot-${this.snapshotCounter}`,
          sessionId: session.id,
          quoteId: session.quoteId,
          quoteLineId: null,
          modelVersionId: session.modelVersionId,
          hash: data.result.hash,
        }
        this.snapshots.set(snapshot.id, snapshot)
        this.sessions.get(session.id)!.evaluation = data.result
        return { ...snapshot }
      },
      complete: async (sessionId, snapshotId, quoteLineId, from) => {
        const session = this.sessions.get(sessionId)
        const snapshot = this.snapshots.get(snapshotId)
        if (!session || !from.includes(session.status) || !snapshot || snapshot.sessionId !== sessionId) return false
        if (!snapshot.quoteLineId) snapshot.quoteLineId = quoteLineId
        session.status = 'finalised'
        return true
      },
    }
  }

  lock(): QuoteLockPort {
    return {
      withLock: async (_quoteId, run) => {
        if (this.lockBusy) return { acquired: false, reason: 'busy' }
        if (this.lockHeld) return { acquired: false, reason: 'held' }
        this.lockHeld = true
        try {
          const value = await run({
            assertHeld: async () => {
              if (this.lockLost) throw new Error('lock connection closed')
            },
          })
          return { acquired: true, value }
        } finally {
          this.lockHeld = false
        }
      },
    }
  }

  deps(): FinaliseDeps {
    return {
      lock: this.lock(),
      store: this.store(),
      sales: {
        readQuote: async () => (this.quoteExists ? quote() : null),
        findLineCarrying: async (kind, _parentId, snapshotId) => {
          if (this.lineReadFailure) throw this.lineReadFailure
          const lines = kind === 'quote' ? this.quoteLines : this.orderLines
          return lines.find((line) => line.body.configuration.productConfigurator.snapshotId === snapshotId)?.id ?? null
        },
        writeLine: (body, updatedAt) => this.writeLine(body, updatedAt),
      },
      prepare: () => this.prepare(),
      observer: {
        snapshotCreated: async (payload) => {
          this.events.push(payload)
        },
        failed: (stage) => {
          this.failures.push(stage)
        },
        outcome: () => undefined,
      },
    }
  }
}

const INPUT = { id: SESSION_ID, expectedHash: HASH, revision: 3 }

function lineBody(snapshotId: string): ConfiguredLineBody {
  return {
    organizationId: ORG_ID,
    tenantId: TENANT_ID,
    quoteId: QUOTE_ID,
    productId: PRODUCT_ID,
    name: 'Pump',
    description: 'Size: Small',
    quantity: 1,
    currencyCode: 'EUR',
    unitPriceNet: '100.00',
    priceMode: 'net',
    taxRateId: TAX_RATE_ID,
    configuration: { productConfigurator: { snapshotId, modelVersionId: VERSION_ID, hash: HASH, summary: 'Size: Small' } },
  }
}

async function failureOf(promise: Promise<unknown>): Promise<FinaliseFailure> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof FinaliseFailure)) throw new Error(`expected a FinaliseFailure, got ${String(error)}`)
  return error
}

describe('finaliseSession', () => {
  it('writes the snapshot, then the trusted line with the quote lock token, links them and emits snapshot.created', async () => {
    const world = new World()
    world.addSession()
    const outcome = await finaliseSession(world.deps(), INPUT)

    expect(outcome).toEqual({ snapshotId: 'snapshot-1', quoteLineId: 'line-1', hash: HASH, replay: false, outcome: 'added' })
    expect(world.writes).toEqual([
      {
        organizationId: ORG_ID,
        tenantId: TENANT_ID,
        quoteId: QUOTE_ID,
        productId: PRODUCT_ID,
        name: 'Pump',
        description: 'Size: Small',
        quantity: 1,
        currencyCode: 'EUR',
        unitPriceNet: '100.00',
        priceMode: 'net',
        taxRateId: TAX_RATE_ID,
        configuration: { productConfigurator: { snapshotId: 'snapshot-1', modelVersionId: VERSION_ID, hash: HASH, summary: 'Size: Small' } },
      },
    ])
    expect(world.lockHeaders).toEqual(['2026-11-06T09:00:00.000Z'])
    expect(world.status()).toBe('finalised')
    expect(world.snapshotOf()?.quoteLineId).toBe('line-1')
    expect(world.events).toEqual([
      {
        snapshotId: 'snapshot-1',
        sessionId: SESSION_ID,
        modelVersionId: VERSION_ID,
        quoteId: QUOTE_ID,
        quoteLineId: 'line-1',
        hash: HASH,
        tenantId: TENANT_ID,
        organizationId: ORG_ID,
      },
    ])
    expect(world.lockHeld).toBe(false)
  })

  it('omits taxRateId when the bound product has none', async () => {
    const world = new World()
    world.addSession()
    world.prepare.mockResolvedValue(prepared({}, null))
    await finaliseSession(world.deps(), INPUT)
    expect(world.writes[0]).not.toHaveProperty('taxRateId')
  })

  it('returns the stored result for a finalised session without taking the lock or evaluating', async () => {
    const world = new World()
    world.addSession()
    await finaliseSession(world.deps(), INPUT)
    world.prepare.mockClear()
    world.lockHeld = true

    await expect(finaliseSession(world.deps(), INPUT)).resolves.toEqual({
      snapshotId: 'snapshot-1',
      quoteLineId: 'line-1',
      hash: HASH,
      replay: true,
      outcome: 'added',
    })
    expect(world.prepare).not.toHaveBeenCalled()
    expect(world.writes).toHaveLength(1)
    await expect(finaliseSession(world.deps(), { ...INPUT, expectedHash: NEW_HASH })).resolves.toMatchObject({
      replay: true,
      outcome: 'added_with_earlier_choices',
    })
  })

  it('refuses a cancelled session and a missing one', async () => {
    const world = new World()
    world.addSession({ status: 'cancelled' })
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('session_not_open')
    expect((await failureOf(finaliseSession(world.deps(), { ...INPUT, id: OTHER_SESSION_ID }))).code).toBe('session_not_found')
    expect(world.writes).toHaveLength(0)
  })

  it('answers quote_converted for a session the conversion cleanup cancelled', async () => {
    const world = new World()
    world.addSession({ status: 'cancelled' })
    world.convert()
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('quote_converted')
    expect(world.writes).toHaveLength(0)
  })

  it('refuses a second finalise on the same quote while the lock is held', async () => {
    const world = new World()
    world.addSession()
    world.addSession({ id: OTHER_SESSION_ID })
    let releaseWrite: () => void = () => undefined
    world.writeLine.mockImplementationOnce(async (body, updatedAt) => {
      await new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      return world.commitLine(body, updatedAt)
    })

    const first = finaliseSession(world.deps(), INPUT)
    await new Promise((resolve) => setImmediate(resolve))
    const second = await failureOf(finaliseSession(world.deps(), { ...INPUT, id: OTHER_SESSION_ID }))
    expect(second.code).toBe('finalise_in_progress')
    expect(world.status(OTHER_SESSION_ID)).toBe('open')

    releaseWrite()
    await expect(first).resolves.toMatchObject({ quoteLineId: 'line-1', replay: false })
    expect(world.writes).toHaveLength(1)
  })

  it('answers finalise_busy, not finalise_in_progress, when no lock connection is free, and keeps the session open', async () => {
    const world = new World()
    world.addSession()
    world.lockBusy = true
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('finalise_busy')
    expect(world.status()).toBe('open')
    expect(world.writes).toHaveLength(0)
  })

  describe('crash after the sales commit', () => {
    /** The line commits, then the process dies before `quote_line_id` is stored: the session stays `finalising`. */
    async function crashAfterCommit(world: World): Promise<void> {
      const session = world.addSession({ status: 'finalising' })
      const snapshot = await world.store().writeSnapshot(session, prepared())
      world.commitLine(lineBody(snapshot.id), quote().updatedAt)
    }

    it('adopts the committed line on retry without re-evaluating', async () => {
      const world = new World()
      await crashAfterCommit(world)

      await expect(finaliseSession(world.deps(), INPUT)).resolves.toEqual({
        snapshotId: 'snapshot-1',
        quoteLineId: 'line-1',
        hash: HASH,
        replay: false,
        outcome: 'added',
      })
      expect(world.prepare).not.toHaveBeenCalled()
      expect(world.writeLine).not.toHaveBeenCalled()
      expect(world.quoteLines).toHaveLength(1)
      expect(world.status()).toBe('finalised')
      expect(world.events).toHaveLength(1)
    })

    it('adopts the committed line even when prices changed since', async () => {
      const world = new World()
      await crashAfterCommit(world)
      world.prepare.mockResolvedValue(prepared({ netPrice: '120.00', hash: NEW_HASH }))

      const outcome = await finaliseSession(world.deps(), INPUT)
      expect(outcome).toMatchObject({ quoteLineId: 'line-1', hash: HASH, outcome: 'added' })
      expect(world.prepare).not.toHaveBeenCalled()
      expect(world.quoteLines.map((line) => line.body.unitPriceNet)).toEqual(['100.00'])
    })

    it('flags added_with_earlier_choices when the retry confirms another result than the committed line', async () => {
      const world = new World()
      await crashAfterCommit(world)
      await expect(finaliseSession(world.deps(), { ...INPUT, expectedHash: NEW_HASH })).resolves.toMatchObject({
        quoteLineId: 'line-1',
        hash: HASH,
        outcome: 'added_with_earlier_choices',
      })
      expect(world.status()).toBe('finalised')
    })

    it('adopts the committed line even when the model was deleted since', async () => {
      const world = new World()
      await crashAfterCommit(world)
      world.prepare.mockRejectedValue(new CrudHttpError(409, { error: 'deleted', code: 'model_deleted' }))

      await expect(finaliseSession(world.deps(), INPUT)).resolves.toMatchObject({ quoteLineId: 'line-1' })
      expect(world.status()).toBe('finalised')
    })

    it('adopts the line from the order when the quote was converted before the retry', async () => {
      const world = new World()
      await crashAfterCommit(world)
      world.convert()

      await expect(finaliseSession(world.deps(), INPUT)).resolves.toMatchObject({ quoteLineId: 'line-1' })
      expect(world.status()).toBe('finalised')
    })

    it('is reconciled by the conversion cleanup: the order line is adopted and the session finalised', async () => {
      const world = new World()
      await crashAfterCommit(world)
      world.addSession({ id: OTHER_SESSION_ID })
      world.convert()

      const report = await reconcileConvertedQuote(world.deps(), { quoteId: QUOTE_ID, orderId: QUOTE_ID })
      expect(report).toEqual({ finalised: [SESSION_ID], cancelled: [OTHER_SESSION_ID], skipped: [] })
      expect(world.status()).toBe('finalised')
      expect(world.snapshotOf()?.quoteLineId).toBe('line-1')
      expect(world.status(OTHER_SESSION_ID)).toBe('cancelled')
      expect(world.events.map((event) => event.quoteLineId)).toEqual(['line-1'])
      await expect(reconcileConvertedQuote(world.deps(), { quoteId: QUOTE_ID, orderId: QUOTE_ID })).resolves.toEqual({
        finalised: [],
        cancelled: [],
        skipped: [],
      })
    })
  })

  describe('sales fails after its commit (post-commit work, interceptors, events, audit)', () => {
    function commitThenFail(world: World, error: Error, afterCommit: () => void = () => undefined): void {
      world.writeLine.mockImplementationOnce(async (body, updatedAt) => {
        world.commitLine(body, updatedAt)
        afterCommit()
        throw error
      })
    }

    it('adopts the committed quote line instead of reopening the session', async () => {
      const world = new World()
      world.addSession()
      commitThenFail(world, new Error('totals event failed'))

      await expect(finaliseSession(world.deps(), INPUT)).resolves.toEqual({
        snapshotId: 'snapshot-1',
        quoteLineId: 'line-1',
        hash: HASH,
        replay: false,
        outcome: 'added',
      })
      expect(world.status()).toBe('finalised')
      expect(world.quoteLines).toHaveLength(1)
      expect(world.events).toHaveLength(1)
      expect(world.failures).toEqual(['line_write_after_commit'])
    })

    it('adopts the line from the order when the quote was converted before the failure was handled', async () => {
      const world = new World()
      world.addSession()
      commitThenFail(world, new CrudHttpError(409, { error: 'conflict' }), () => world.convert())

      await expect(finaliseSession(world.deps(), INPUT)).resolves.toMatchObject({ quoteLineId: 'line-1', replay: false })
      expect(world.status()).toBe('finalised')
      expect(world.orderLines).toHaveLength(1)
    })

    it('keeps the session finalising when the lines cannot be read, and the next finalise reconciles it', async () => {
      const world = new World()
      world.addSession()
      commitThenFail(world, new Error('audit failed'), () => {
        world.lineReadFailure = new Error('database unavailable')
      })

      const failure = await failureOf(finaliseSession(world.deps(), INPUT))
      expect(failure.code).toBe('quote_line_write_failed')
      expect(failure.details).toEqual({ status: 'finalising' })
      expect(world.status()).toBe('finalising')
      expect(world.failures).toEqual(['line_write', 'line_reconcile'])

      world.lineReadFailure = null
      world.prepare.mockClear()
      await expect(finaliseSession(world.deps(), INPUT)).resolves.toMatchObject({ quoteLineId: 'line-1' })
      expect(world.prepare).not.toHaveBeenCalled()
      expect(world.quoteLines).toHaveLength(1)
    })

    it('stores the confirmed new price as the session evaluation, so finishing from the stored session adds without a warning', async () => {
      const world = new World()
      world.addSession({ evaluation: result() })
      world.prepare.mockResolvedValue(prepared({ netPrice: '120.00', hash: NEW_HASH }))
      expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('result_changed')
      commitThenFail(world, new Error('audit failed'), () => {
        world.lineReadFailure = new Error('database unavailable')
      })
      const uncertain = await failureOf(finaliseSession(world.deps(), { ...INPUT, expectedHash: NEW_HASH }))
      expect(uncertain.details).toEqual({ status: 'finalising' })

      world.lineReadFailure = null
      const stored = await world.store().findSession(SESSION_ID)
      expect(stored?.evaluation).toMatchObject({ hash: NEW_HASH, netPrice: '120.00' })
      const expectedHash = String(stored?.evaluation?.hash)
      await expect(finaliseSession(world.deps(), { ...INPUT, expectedHash })).resolves.toMatchObject({
        quoteLineId: 'line-1',
        hash: NEW_HASH,
        outcome: 'added',
      })
    })
  })

  describe('an open session whose snapshot is already carried by a line', () => {
    async function reopenedAfterCommit(world: World): Promise<void> {
      const session = world.addSession({ status: 'finalising' })
      const snapshot = await world.store().writeSnapshot(session, prepared())
      world.commitLine(lineBody(snapshot.id), quote().updatedAt)
      world.sessions.get(SESSION_ID)!.status = 'open'
    }

    it('adopts the line when the rep confirms the same result', async () => {
      const world = new World()
      await reopenedAfterCommit(world)
      await expect(finaliseSession(world.deps(), INPUT)).resolves.toMatchObject({ quoteLineId: 'line-1', hash: HASH, replay: false })
      expect(world.status()).toBe('finalised')
      expect(world.prepare).not.toHaveBeenCalled()
    })

    it('finalises with the line already added and answers added_with_earlier_choices when the rep confirmed another result', async () => {
      const world = new World()
      await reopenedAfterCommit(world)
      world.sessions.get(SESSION_ID)!.revision = 4

      await expect(finaliseSession(world.deps(), { ...INPUT, revision: 4, expectedHash: NEW_HASH })).resolves.toEqual({
        snapshotId: 'snapshot-1',
        quoteLineId: 'line-1',
        hash: HASH,
        replay: false,
        outcome: 'added_with_earlier_choices',
      })
      expect(world.status()).toBe('finalised')
      expect(world.events).toHaveLength(1)
      expect(world.snapshotOf()?.quoteLineId).toBe('line-1')
      expect(world.prepare).not.toHaveBeenCalled()
      expect(world.writeLine).not.toHaveBeenCalled()
      expect(world.quoteLines).toHaveLength(1)
    })
  })

  it('replaces an unlinked snapshot when no line was committed and prices changed', async () => {
    const world = new World()
    world.addSession()
    world.writeLine.mockRejectedValueOnce(new Error('connection reset'))
    const failure = await failureOf(finaliseSession(world.deps(), INPUT))
    expect(failure.code).toBe('quote_line_write_failed')
    expect(failure.details).toEqual({ status: 'open' })
    expect(world.status()).toBe('open')
    expect(world.failures).toContain('line_write')

    world.prepare.mockResolvedValue(prepared({ netPrice: '120.00', hash: NEW_HASH }))
    const outcome = await finaliseSession(world.deps(), { ...INPUT, expectedHash: NEW_HASH })
    expect(outcome).toMatchObject({ snapshotId: 'snapshot-2', quoteLineId: 'line-1', hash: NEW_HASH })
    expect(world.snapshots.size).toBe(1)
    expect(world.writes.map((body) => body.unitPriceNet)).toEqual(['120.00'])
  })

  it('answers session_changed for a stale revision and reopens the session', async () => {
    const world = new World()
    world.addSession()
    const failure = await failureOf(finaliseSession(world.deps(), { ...INPUT, revision: 2 }))
    expect(failure.code).toBe('session_changed')
    expect(failure.details.session).toMatchObject({ id: SESSION_ID, revision: 3, status: 'open' })
    expect(world.status()).toBe('open')
    expect(world.prepare).not.toHaveBeenCalled()
  })

  it('answers result_changed with the new result and writes nothing', async () => {
    const world = new World()
    world.addSession()
    world.prepare.mockResolvedValue(prepared({ netPrice: '120.00', hash: NEW_HASH }))
    const failure = await failureOf(finaliseSession(world.deps(), INPUT))
    expect(failure.code).toBe('result_changed')
    expect(failure.details.result).toMatchObject({ netPrice: '120.00', hash: NEW_HASH })
    expect(world.snapshots.size).toBe(0)
    expect(world.writes).toHaveLength(0)
    expect(world.status()).toBe('open')
  })

  it('refuses a result that is not finalisable', async () => {
    const world = new World()
    world.addSession()
    world.prepare.mockResolvedValue(prepared({ finalisable: false }))
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('not_finalisable')
    expect(world.status()).toBe('open')
  })

  it('reopens the session when preparing fails (model deleted, product missing, evaluation errors)', async () => {
    const world = new World()
    world.addSession()
    const error = new CrudHttpError(409, { error: 'deleted', code: 'model_deleted' })
    world.prepare.mockRejectedValue(error)
    await expect(finaliseSession(world.deps(), INPUT)).rejects.toBe(error)
    expect(world.status()).toBe('open')
    expect(world.writes).toHaveLength(0)
  })

  it('needs migrationAcknowledged when the session carries migration items', async () => {
    const world = new World()
    world.addSession({ migration: { kept: [], dropped: [{ featureKey: 'size' }], reset: [] } })
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('migration_unconfirmed')
    await expect(finaliseSession(world.deps(), { ...INPUT, migrationAcknowledged: true })).resolves.toMatchObject({ replay: false })
  })

  it('cancels the session when the quote is gone before evaluation', async () => {
    const world = new World()
    world.addSession()
    world.quoteExists = false
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('quote_converted')
    expect(world.status()).toBe('cancelled')
    expect(world.prepare).not.toHaveBeenCalled()
  })

  it('maps a sales 409 to quote_changed and keeps the session open', async () => {
    const world = new World()
    world.addSession()
    world.writeLine.mockRejectedValueOnce(new CrudHttpError(409, { error: 'record_modified', code: 'optimistic_lock_conflict' }))
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('quote_changed')
    expect(world.status()).toBe('open')
  })

  it('reopens the session on a sales 404 while the quote still exists', async () => {
    const world = new World()
    world.addSession()
    world.writeLine.mockRejectedValueOnce(new CrudHttpError(404, { error: 'Sales quote not found' }))
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('quote_line_write_failed')
    expect(world.status()).toBe('open')
  })

  it('maps a sales 404 after which the quote is gone to quote_converted and cancels the session', async () => {
    const world = new World()
    world.addSession()
    world.writeLine.mockImplementationOnce(async () => {
      world.quoteExists = false
      throw new CrudHttpError(404, { error: 'Sales quote not found' })
    })
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('quote_converted')
    expect(world.status()).toBe('cancelled')
  })

  it('maps another failure after which the quote is gone to quote_converted', async () => {
    const world = new World()
    world.addSession()
    world.writeLine.mockImplementationOnce(async () => {
      world.quoteExists = false
      throw new Error('insert or update on table "sales_quote_lines" violates foreign key constraint')
    })
    expect((await failureOf(finaliseSession(world.deps(), INPUT))).code).toBe('quote_converted')
    expect(world.status()).toBe('cancelled')
  })

  it('stops before the next write when the lock connection is lost and leaves the session finalising', async () => {
    const world = new World()
    world.addSession()
    world.lockLost = true
    await expect(finaliseSession(world.deps(), INPUT)).rejects.toThrow('lock connection closed')
    expect(world.snapshots.size).toBe(0)
    expect(world.writes).toHaveLength(0)
    expect(world.status()).toBe('finalising')
    expect(world.failures).toEqual(['lock_lost'])

    world.lockLost = false
    await expect(finaliseSession(world.deps(), INPUT)).resolves.toMatchObject({ replay: false })
  })
})

describe('reconcileConvertedQuote', () => {
  function addSessions(world: World, count: number, status: ConfigurationSessionStatus = 'open'): string[] {
    return Array.from({ length: count }, (_, index) => {
      const id = `session-${String(index).padStart(4, '0')}`
      world.addSession({ id, status })
      return id
    })
  }

  it('reconciles every session in batches, past the first 100', async () => {
    const world = new World()
    const ids = addSessions(world, RECONCILE_BATCH_SIZE + 1)
    world.convert()
    const report = await reconcileConvertedQuote(world.deps(), { quoteId: QUOTE_ID, orderId: QUOTE_ID })
    expect(report.cancelled).toEqual(ids)
    expect(ids.every((id) => world.status(id) === 'cancelled')).toBe(true)
    expect(world.listCalls).toBe(2)
  })

  it('with the lock busy also visits every batch', async () => {
    const world = new World()
    const ids = addSessions(world, RECONCILE_BATCH_SIZE + 1)
    world.lockHeld = true
    const report = await reconcileConvertedQuote(world.deps(), { quoteId: QUOTE_ID, orderId: QUOTE_ID })
    expect(report.cancelled).toEqual(ids)
  })

  it('cancels open sessions of the converted quote', async () => {
    const world = new World()
    world.addSession()
    world.addSession({ id: OTHER_SESSION_ID, status: 'cancelled' })
    world.convert()
    const report = await reconcileConvertedQuote(world.deps(), { quoteId: QUOTE_ID, orderId: QUOTE_ID })
    expect(report).toEqual({ finalised: [], cancelled: [SESSION_ID], skipped: [] })
    expect(world.status(OTHER_SESSION_ID)).toBe('cancelled')
  })

  it('with the lock busy cancels only open sessions without a snapshot and leaves finalising ones to the running finalise', async () => {
    const world = new World()
    world.addSession({ status: 'finalising' })
    world.addSession({ id: OTHER_SESSION_ID })
    world.lockHeld = true
    const report = await reconcileConvertedQuote(world.deps(), { quoteId: QUOTE_ID, orderId: QUOTE_ID })
    expect(report).toEqual({ finalised: [], cancelled: [OTHER_SESSION_ID], skipped: [SESSION_ID] })
    expect(world.status()).toBe('finalising')
  })

  it('reads the order named by the conversion result', async () => {
    const world = new World()
    world.addSession({ status: 'finalising' })
    world.snapshots.set('snapshot-9', {
      id: 'snapshot-9',
      sessionId: SESSION_ID,
      quoteId: QUOTE_ID,
      quoteLineId: null,
      modelVersionId: VERSION_ID,
      hash: HASH,
    })
    const deps = world.deps()
    const findLineCarrying = jest.fn(async () => 'order-line-1')
    deps.sales.findLineCarrying = findLineCarrying
    const report = await reconcileConvertedQuote(deps, { quoteId: QUOTE_ID, orderId: 'explicit-order' })
    expect(findLineCarrying).toHaveBeenCalledWith('order', 'explicit-order', 'snapshot-9')
    expect(report.finalised).toEqual([SESSION_ID])
  })
})
