/** @jest-environment node */
import { LockMode } from '@mikro-orm/core'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands/types'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { ConfigurationModel, ConfigurationModelVersion } from '../../data/entities'
import type { ModelCreateInput } from '../../data/validators'
import { buildEmptyDefinition, computeDraftHash } from '../../lib/modelDraft'
import '../models'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const MODEL_ID = '33333333-3333-4333-8333-333333333333'
const PRODUCT_ID = '44444444-4444-4444-8444-444444444444'
const PRICE_KIND_ID = '55555555-5555-4555-8555-555555555555'
const VERSION_ID = '66666666-6666-4666-8666-666666666666'
const UPDATED_AT = new Date('2026-11-01T10:00:00.000Z')

const validateModelDraftMock = jest.fn()
const emitEventMock = jest.fn(async () => undefined)
const findOneWithDecryptionMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
}))

jest.mock('../../lib/modelValidation', () => ({
  validateModelDraft: (...args: unknown[]) => validateModelDraftMock(...args),
}))

jest.mock('../../events', () => ({
  emitProductConfiguratorEvent: (...args: unknown[]) => emitEventMock(...(args as [])),
}))

type Row = Record<string, unknown>
type MockEm = {
  fork: () => unknown
  count: jest.Mock
  create: jest.Mock
  persist: jest.Mock
  flush: jest.Mock
  transactional: jest.Mock
  begin: jest.Mock
  commit: jest.Mock
  rollback: jest.Mock
}

function makeModel(overrides: Partial<ConfigurationModel> = {}): ConfigurationModel {
  const draftDefinition = buildEmptyDefinition({ currencyCode: 'EUR', priceKindId: PRICE_KIND_ID })
  return Object.assign(new ConfigurationModel(), {
    id: MODEL_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    productId: PRODUCT_ID,
    modelKey: 'pump',
    title: 'Pump',
    currencyCode: 'EUR',
    draftDefinition,
    draftHash: computeDraftHash(draftDefinition),
    latestVersionId: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    deletedAt: null,
    ...overrides,
  })
}

function makeEm(options: { count?: number } = {}) {
  const created: Row[] = []
  const em: { fork: () => unknown } & Record<string, unknown> = {
    fork: () => em,
    count: jest.fn(async () => options.count ?? 0),
    create: jest.fn((entity: unknown, data: Row) => {
      const record = Object.assign(entity === ConfigurationModel ? new ConfigurationModel() : new ConfigurationModelVersion(), {
        id: entity === ConfigurationModel ? MODEL_ID : data.id,
        ...data,
      })
      created.push(record as unknown as Row)
      return record
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
    transactional: jest.fn(async (fn: (trx: unknown) => Promise<unknown>): Promise<unknown> => fn(em)),
    begin: jest.fn(async () => undefined),
    commit: jest.fn(async () => undefined),
    rollback: jest.fn(async () => undefined),
  }
  return { em: em as MockEm, created }
}

function makeCtx(em: unknown, options: { selectedOrganizationId?: string | null; lockHeader?: string } = {}) {
  const dataEngine = { markOrmEntityChange: jest.fn() }
  const headers = new Headers()
  if (options.lockHeader) headers.set(OPTIMISTIC_LOCK_HEADER_NAME, options.lockHeader)
  const ctx: CommandRuntimeContext = {
    container: {
      resolve: (token: string) => {
        if (token === 'em') return em
        if (token === 'dataEngine') return dataEngine
        return undefined
      },
    } as unknown as CommandRuntimeContext['container'],
    auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID } as CommandRuntimeContext['auth'],
    organizationScope: null,
    selectedOrganizationId: options.selectedOrganizationId === undefined ? ORG_ID : options.selectedOrganizationId,
    organizationIds: [ORG_ID],
    request: new Request('http://localhost/api/product_configurator/models', { method: 'PUT', headers }),
  }
  return { ctx, dataEngine }
}

function handler<TInput, TResult>(id: string): CommandHandler<TInput, TResult> {
  const registered = commandRegistry.get(id)
  if (!registered) throw new Error(`${id} not registered`)
  return registered as CommandHandler<TInput, TResult>
}

const createInput: ModelCreateInput = {
  productId: PRODUCT_ID,
  modelKey: 'pump',
  title: 'Pump',
  currencyCode: 'EUR',
  priceKindId: PRICE_KIND_ID,
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('product_configurator.models.create', () => {
  const create = handler<ModelCreateInput, { id: string }>('product_configurator.models.create')

  it('stores an empty skeleton with the commercial values and its hash', async () => {
    const { em, created } = makeEm()
    const { ctx, dataEngine } = makeCtx(em)

    await expect(create.execute(createInput, ctx)).resolves.toEqual({ id: MODEL_ID })

    const model = created[0]
    expect(model).toMatchObject({ tenantId: TENANT_ID, organizationId: ORG_ID, currencyCode: 'EUR', latestVersionId: null })
    expect(model.draftDefinition).toEqual(buildEmptyDefinition({ currencyCode: 'EUR', priceKindId: PRICE_KIND_ID }))
    expect(model.draftHash).toBe(computeDraftHash(model.draftDefinition as Record<string, unknown>))
    expect(dataEngine.markOrmEntityChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'created', identifiers: { id: MODEL_ID, tenantId: TENANT_ID, organizationId: ORG_ID } }),
    )
  })

  it('rejects a model key already used in the organization', async () => {
    const { em } = makeEm({ count: 1 })
    const { ctx } = makeCtx(em)

    await expect(create.execute(createInput, ctx)).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'duplicate_model_key' }),
    })
    expect(em.persist).not.toHaveBeenCalled()
  })

  it('rejects a draft whose currency differs from the model currency', async () => {
    const { em } = makeEm()
    const { ctx } = makeCtx(em)
    const draftDefinition = buildEmptyDefinition({ currencyCode: 'USD', priceKindId: PRICE_KIND_ID })

    await expect(create.execute({ ...createInput, draftDefinition }, ctx)).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ code: 'invalid_definition', reason: 'currency_code_mismatch' }),
    })
  })

  it('takes the tenant from the organization scope of a trusted context without auth', async () => {
    const { em, created } = makeEm()
    const { ctx } = makeCtx(em)
    const systemCtx: CommandRuntimeContext = {
      ...ctx,
      auth: null,
      systemActor: true,
      organizationScope: { selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: [ORG_ID], tenantId: TENANT_ID },
    }

    await expect(create.execute(createInput, systemCtx)).resolves.toEqual({ id: MODEL_ID })
    expect(created[0]).toMatchObject({ tenantId: TENANT_ID, organizationId: ORG_ID })
  })

  it('needs a single selected organization', async () => {
    const { em } = makeEm()
    const { ctx } = makeCtx(em, { selectedOrganizationId: null })

    await expect(create.execute(createInput, ctx)).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ code: 'organization_scope_required' }),
    })
  })

  it('undo soft-deletes the created model', async () => {
    const model = makeModel()
    const { em } = makeEm()
    const { ctx } = makeCtx(em)
    findOneWithDecryptionMock.mockResolvedValue(model)

    await create.undo!({
      input: createInput,
      ctx,
      logEntry: { commandPayload: { undo: { after: { id: MODEL_ID, tenantId: TENANT_ID, organizationId: ORG_ID } } } },
    })

    expect(model.deletedAt).toBeInstanceOf(Date)
    expect(em.flush).toHaveBeenCalled()
  })
})

describe('product_configurator.models.update', () => {
  const update = handler<
    { id: string; title?: string; draftDefinition?: Record<string, unknown> },
    { id: string; updatedAt: string; draftHash: string }
  >('product_configurator.models.update')

  it('returns 404 for a model outside the scope', async () => {
    const { em } = makeEm()
    const { ctx } = makeCtx(em)
    findOneWithDecryptionMock.mockResolvedValue(null)

    await expect(update.execute({ id: MODEL_ID, title: 'New' }, ctx)).rejects.toMatchObject({ status: 404 })
    expect(findOneWithDecryptionMock).toHaveBeenCalledWith(
      em,
      ConfigurationModel,
      { id: MODEL_ID, tenantId: TENANT_ID, organizationId: ORG_ID, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      { tenantId: TENANT_ID, organizationId: ORG_ID },
    )
    expect(em.rollback).toHaveBeenCalled()
  })

  it('takes the row lock inside a transaction and the undo snapshot before mutating', async () => {
    const model = makeModel()
    const { em } = makeEm()
    const { ctx } = makeCtx(em, { lockHeader: UPDATED_AT.toISOString() })
    findOneWithDecryptionMock.mockResolvedValue(model)
    const seenTitles: string[] = []
    ctx.beforeTransactionalWrite = jest.fn(async () => {
      expect(em.begin).toHaveBeenCalled()
      seenTitles.push(model.title)
    })

    await update.execute({ id: MODEL_ID, title: 'Pump XL' }, ctx)

    expect(update.prepareSnapshotInsideTransaction).toBe(true)
    expect(ctx.beforeTransactionalWrite).toHaveBeenCalledWith(em, { id: MODEL_ID, title: 'Pump XL' })
    expect(seenTitles).toEqual(['Pump'])
    expect(em.commit).toHaveBeenCalled()
  })

  it('rejects a stale optimistic-lock token', async () => {
    const { em } = makeEm()
    const { ctx } = makeCtx(em, { lockHeader: '2026-10-01T00:00:00.000Z' })
    findOneWithDecryptionMock.mockResolvedValue(makeModel())

    await expect(update.execute({ id: MODEL_ID, title: 'New' }, ctx)).rejects.toMatchObject({ status: 409 })
    expect(em.flush).not.toHaveBeenCalled()
  })

  it('saves the title and the draft with a new draft hash', async () => {
    const model = makeModel()
    const { em } = makeEm()
    const { ctx } = makeCtx(em, { lockHeader: UPDATED_AT.toISOString() })
    findOneWithDecryptionMock.mockResolvedValue(model)
    const draftDefinition = { ...buildEmptyDefinition({ currencyCode: 'EUR', priceKindId: PRICE_KIND_ID }), features: [{ broken: true }] }

    const result = await update.execute({ id: MODEL_ID, title: 'Pump XL', draftDefinition }, ctx)

    expect(result.id).toBe(MODEL_ID)
    expect(model.title).toBe('Pump XL')
    expect(model.draftDefinition).toEqual(draftDefinition)
    expect(model.draftHash).toBe(computeDraftHash(draftDefinition))
    expect(result.draftHash).toBe(model.draftHash)
    expect(em.flush).toHaveBeenCalled()
  })

  it('returns the unchanged draft hash when only the title is saved', async () => {
    const model = makeModel()
    const hashBefore = model.draftHash
    const { em } = makeEm()
    const { ctx } = makeCtx(em, { lockHeader: UPDATED_AT.toISOString() })
    findOneWithDecryptionMock.mockResolvedValue(model)

    const result = await update.execute({ id: MODEL_ID, title: 'Pump XL' }, ctx)

    expect(result.draftHash).toBe(hashBefore)
  })

  it('rejects a draft that changes the model currency', async () => {
    const { em } = makeEm()
    const { ctx } = makeCtx(em)
    findOneWithDecryptionMock.mockResolvedValue(makeModel())
    const draftDefinition = buildEmptyDefinition({ currencyCode: 'USD', priceKindId: PRICE_KIND_ID })

    await expect(update.execute({ id: MODEL_ID, draftDefinition }, ctx)).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ code: 'invalid_definition' }),
    })
  })

  it('undo restores the previous title and draft', async () => {
    const model = makeModel({ title: 'Changed', draftHash: 'changed' })
    const { em } = makeEm()
    const { ctx } = makeCtx(em)
    findOneWithDecryptionMock.mockResolvedValue(model)
    const before = {
      id: MODEL_ID,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      title: 'Pump',
      draftHash: 'before-hash',
      draftDefinition: { schemaVersion: 1 },
    }

    await update.undo!({ input: { id: MODEL_ID }, ctx, logEntry: { commandPayload: { undo: { before } } } })

    expect(model).toMatchObject({ title: 'Pump', draftHash: 'before-hash', draftDefinition: { schemaVersion: 1 } })
  })
})

describe('product_configurator.models.delete', () => {
  const remove = handler<{ id: string }, { id: string }>('product_configurator.models.delete')

  it('soft-deletes the model and emits the deleted side effects', async () => {
    const model = makeModel()
    const { em } = makeEm()
    const { ctx, dataEngine } = makeCtx(em, { lockHeader: UPDATED_AT.toISOString() })
    findOneWithDecryptionMock.mockResolvedValue(model)

    await remove.execute({ id: MODEL_ID }, ctx)

    expect(model.deletedAt).toBeInstanceOf(Date)
    expect(dataEngine.markOrmEntityChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'deleted' }))
  })

  it('undo restores a deleted model', async () => {
    const model = makeModel({ deletedAt: new Date() })
    const { em } = makeEm()
    const { ctx } = makeCtx(em)
    findOneWithDecryptionMock.mockResolvedValue(model)

    await remove.undo!({
      input: { id: MODEL_ID },
      ctx,
      logEntry: { commandPayload: { undo: { before: { id: MODEL_ID, tenantId: TENANT_ID, organizationId: ORG_ID } } } },
    })

    expect(model.deletedAt).toBeNull()
  })
})

describe('product_configurator.models.publish', () => {
  const publish = handler<{ id: string }, { modelVersionId: string; version: number; hash: string; updatedAt: string }>(
    'product_configurator.models.publish',
  )

  it('is not undoable', () => {
    expect(publish.isUndoable).toBe(false)
  })

  it('refuses to publish when the publication checks fail', async () => {
    const { em } = makeEm()
    const { ctx } = makeCtx(em)
    findOneWithDecryptionMock.mockResolvedValue(makeModel())
    const report = { ok: false, issues: [{ check: 'price_kind', code: 'price_kind_missing', params: {}, refs: [] }] }
    validateModelDraftMock.mockResolvedValue(report)

    await expect(publish.execute({ id: MODEL_ID }, ctx)).rejects.toMatchObject({
      status: 422,
      body: expect.objectContaining({ code: 'validation_failed', report }),
    })
    expect(em.transactional).not.toHaveBeenCalled()
  })

  it('freezes the next version with hash and report and makes it the latest', async () => {
    const model = makeModel({ latestVersionId: VERSION_ID })
    const { em, created } = makeEm()
    const { ctx, dataEngine } = makeCtx(em)
    const report = { ok: true, issues: [] }
    validateModelDraftMock.mockResolvedValue(report)
    findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) =>
      entity === ConfigurationModelVersion ? { id: VERSION_ID, version: 2 } : model,
    )
    const flushedAt = new Date(UPDATED_AT.getTime() + 1000)
    em.flush.mockImplementation(async () => {
      model.updatedAt = flushedAt
    })

    const result = await publish.execute({ id: MODEL_ID }, ctx)

    const version = created[0]
    expect(result).toEqual({ modelVersionId: version.id, version: 3, hash: model.draftHash, updatedAt: flushedAt.toISOString() })
    expect(version).toMatchObject({ modelId: MODEL_ID, version: 3, validationReport: report, tenantId: TENANT_ID, organizationId: ORG_ID })
    expect(model.latestVersionId).toBe(version.id)
    expect(dataEngine.markOrmEntityChange).toHaveBeenCalledWith(expect.objectContaining({ action: 'updated', events: undefined }))
    expect(emitEventMock).toHaveBeenCalledWith('product_configurator.model_version.published', {
      modelId: MODEL_ID,
      modelVersionId: version.id,
      version: 3,
      hash: model.draftHash,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
    })
  })

  it('stops when the draft changed between validation and the row lock', async () => {
    const validated = makeModel()
    const locked = makeModel({ draftHash: 'edited-meanwhile' })
    const { em } = makeEm()
    const { ctx } = makeCtx(em)
    validateModelDraftMock.mockResolvedValue({ ok: true, issues: [] })
    findOneWithDecryptionMock.mockResolvedValueOnce(validated).mockResolvedValueOnce(locked)

    await expect(publish.execute({ id: MODEL_ID }, ctx)).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'draft_changed' }),
    })
    expect(em.persist).not.toHaveBeenCalled()
  })
})

/**
 * In-memory stand-in for one `configuration_models` row: a PESSIMISTIC_WRITE read waits until the
 * holder's transaction ends, writes become visible on commit, and every flush bumps `updatedAt`
 * the way the entity's `onUpdate` does.
 */
function makeLockingRowStore(initial: ConfigurationModel) {
  let committed: ConfigurationModel = makeModel({ ...initial })
  let lockQueue: Promise<void> = Promise.resolve()
  let clock = 0

  function fork() {
    let releaseLock: (() => void) | null = null
    let loaded: ConfigurationModel | null = null
    let staged: ConfigurationModel | null = null
    const em = {
      fork,
      create: jest.fn((_entity: unknown, data: Row) => Object.assign(new ConfigurationModelVersion(), data)),
      persist: jest.fn(),
      async begin() {},
      async flush() {
        if (!loaded) return
        clock += 1
        loaded.updatedAt = new Date(UPDATED_AT.getTime() + clock * 1000)
        staged = makeModel({ ...loaded })
      },
      async commit() {
        if (staged) committed = staged
        staged = null
        releaseLock?.()
      },
      async rollback() {
        staged = null
        releaseLock?.()
      },
      async transactional(fn: (trx: unknown) => Promise<unknown>) {
        await em.begin()
        try {
          const result = await fn(em)
          await em.commit()
          return result
        } catch (error) {
          await em.rollback()
          throw error
        }
      },
      async read(where: Row, options?: { lockMode?: LockMode }) {
        if (options?.lockMode === LockMode.PESSIMISTIC_WRITE) {
          const previous = lockQueue
          lockQueue = new Promise<void>((resolve) => {
            releaseLock = resolve
          })
          await previous
        }
        if ('deletedAt' in where && committed.deletedAt) return null
        loaded = makeModel({ ...committed })
        return loaded
      },
    }
    return em
  }

  return { em: fork(), current: () => committed }
}

describe('product_configurator.models concurrent writes', () => {
  const update = handler<{ id: string; title?: string }, { id: string; updatedAt: string }>('product_configurator.models.update')
  const remove = handler<{ id: string }, { id: string }>('product_configurator.models.delete')
  const publish = handler<{ id: string }, { modelVersionId: string; version: number; hash: string }>(
    'product_configurator.models.publish',
  )

  beforeEach(() => {
    findOneWithDecryptionMock.mockImplementation(
      async (em: { read?: (where: Row, options?: { lockMode?: LockMode }) => Promise<unknown> }, entity: unknown, where: Row, options?: { lockMode?: LockMode }) =>
        entity === ConfigurationModelVersion ? null : em.read!(where, options),
    )
  })

  it('lets only one of two updates holding the same token win', async () => {
    const store = makeLockingRowStore(makeModel())
    const token = UPDATED_AT.toISOString()

    const results = await Promise.allSettled([
      update.execute({ id: MODEL_ID, title: 'First' }, makeCtx(store.em, { lockHeader: token }).ctx),
      update.execute({ id: MODEL_ID, title: 'Second' }, makeCtx(store.em, { lockHeader: token }).ctx),
    ])

    expect(results.map((result) => result.status).sort((left, right) => left.localeCompare(right))).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected?.reason).toMatchObject({ status: 409 })
    expect(store.current().title).toBe('First')
  })

  it('rejects a delete racing an update with the same token', async () => {
    const store = makeLockingRowStore(makeModel())
    const token = UPDATED_AT.toISOString()

    const [updated, deleted] = await Promise.allSettled([
      update.execute({ id: MODEL_ID, title: 'Renamed' }, makeCtx(store.em, { lockHeader: token }).ctx),
      remove.execute({ id: MODEL_ID }, makeCtx(store.em, { lockHeader: token }).ctx),
    ])

    expect(updated.status).toBe('fulfilled')
    expect(deleted).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })
    expect(store.current()).toMatchObject({ title: 'Renamed', deletedAt: null })
  })

  it('rejects an update racing a delete with the same token', async () => {
    const store = makeLockingRowStore(makeModel())
    const token = UPDATED_AT.toISOString()

    const [deleted, updated] = await Promise.allSettled([
      remove.execute({ id: MODEL_ID }, makeCtx(store.em, { lockHeader: token }).ctx),
      update.execute({ id: MODEL_ID, title: 'Renamed' }, makeCtx(store.em, { lockHeader: token }).ctx),
    ])

    expect(deleted.status).toBe('fulfilled')
    expect(updated).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ status: 409 }) })
    expect(store.current()).toMatchObject({ title: 'Pump', deletedAt: expect.any(Date) })
  })

  it('refuses to publish with a stale token when the title changed during validation', async () => {
    const store = makeLockingRowStore(makeModel())
    const token = UPDATED_AT.toISOString()
    validateModelDraftMock.mockImplementation(async () => {
      await update.execute({ id: MODEL_ID, title: 'Renamed' }, makeCtx(store.em, { lockHeader: token }).ctx)
      return { ok: true, issues: [] }
    })

    await expect(publish.execute({ id: MODEL_ID }, makeCtx(store.em, { lockHeader: token }).ctx)).rejects.toMatchObject({
      status: 409,
    })
    expect(store.current()).toMatchObject({ title: 'Renamed', latestVersionId: null })
    expect(emitEventMock).not.toHaveBeenCalled()
  })
})
