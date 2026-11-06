/** @jest-environment node */
import { LockMode } from '@mikro-orm/core'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands/types'
import { ConfigurationModel, ConfigurationModelVersion, ConfigurationSession, ConfigurationSnapshot } from '../../data/entities'
import type { ConfigurationDefinition, Feature, SessionEvaluateInput, SessionIdInput, SessionOpenInput } from '../../data/validators'
import { ConfiguratorEvaluationError } from '../../lib/evaluator/errors'
import { buildEmptyDefinition } from '../../lib/modelDraft'
import type { SessionCancelResult, SessionEvaluateResult, SessionOpenResult } from '../sessions'
import '../sessions'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const MODEL_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_MODEL_ID = '55555555-5555-4555-8555-555555555555'
const VERSION_ID = '66666666-6666-4666-8666-666666666666'
const SESSION_ID = '77777777-7777-4777-8777-777777777777'
const USER_ID = '88888888-8888-4888-8888-888888888888'
const CUSTOMER_ID = '99999999-9999-4999-8999-999999999999'
const CHANNEL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PRICE_KIND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SNAPSHOT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OLD_VERSION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OTHER_QUOTE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const findOneWithDecryptionMock = jest.fn()
const findWithDecryptionMock = jest.fn()
const evaluateConfigurationMock = jest.fn()
const queryMock = jest.fn()
const userHasAllFeaturesMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))

jest.mock('@open-mercato/shared/lib/encryption/entityIds', () => ({
  getEntityIds: () => ({ sales: { sales_quote: 'sales:sales_quote' }, auth: { user: 'auth:user' } }),
}))

jest.mock('../../lib/evaluation', () => ({
  evaluateConfiguration: (...args: unknown[]) => evaluateConfigurationMock(...args),
}))

type QuoteRow = Record<string, unknown>

function quoteRow(overrides: QuoteRow = {}): QuoteRow {
  return {
    id: QUOTE_ID,
    organization_id: ORG_ID,
    quote_number: 'Q-1001',
    status: 'draft',
    currency_code: 'EUR',
    channel_id: CHANNEL_ID,
    customer_entity_id: CUSTOMER_ID,
    customer_snapshot: { customer: { displayName: 'Acme Ltd' } },
    updated_at: '2026-11-06T10:00:00.000Z',
    ...overrides,
  }
}

function model(overrides: Partial<ConfigurationModel> = {}): ConfigurationModel {
  return Object.assign(new ConfigurationModel(), {
    id: MODEL_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    modelKey: 'pump',
    title: 'Pump',
    currencyCode: 'EUR',
    latestVersionId: VERSION_ID,
    deletedAt: null,
    ...overrides,
  })
}

function version(currencyCode = 'EUR'): ConfigurationModelVersion {
  return Object.assign(new ConfigurationModelVersion(), {
    id: VERSION_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    modelId: MODEL_ID,
    version: 3,
    hash: 'f'.repeat(64),
    definition: buildEmptyDefinition({ currencyCode, priceKindId: PRICE_KIND_ID }),
  })
}

function session(overrides: Partial<ConfigurationSession> = {}): ConfigurationSession {
  return Object.assign(new ConfigurationSession(), {
    id: SESSION_ID,
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    modelVersionId: VERSION_ID,
    quoteId: QUOTE_ID,
    selections: { size: 's' },
    evaluation: null,
    revision: 2,
    mode: 'new',
    status: 'open',
    createdBy: USER_ID,
    ...overrides,
  })
}

function makeEm() {
  const created: ConfigurationSession[] = []
  const em: Record<string, unknown> = {}
  Object.assign(em, {
    fork: () => em,
    create: jest.fn((_entity: unknown, data: Partial<ConfigurationSession>) => {
      const record = Object.assign(new ConfigurationSession(), { id: SESSION_ID, ...data })
      created.push(record)
      return record
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
    transactional: jest.fn(async (fn: (trx: unknown) => Promise<unknown>) => fn(em)),
  })
  return { em, created }
}

function makeCtx(em: unknown, options: { selectedOrganizationId?: string | null } = {}): CommandRuntimeContext {
  return {
    container: {
      resolve: (token: string) => {
        if (token === 'em') return em
        if (token === 'queryEngine') return { query: queryMock }
        if (token === 'rbacService') return { userHasAllFeatures: userHasAllFeaturesMock }
        throw new Error(`Could not resolve ${token}`)
      },
    } as unknown as CommandRuntimeContext['container'],
    auth: { sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID } as CommandRuntimeContext['auth'],
    organizationScope: null,
    selectedOrganizationId: options.selectedOrganizationId === undefined ? ORG_ID : options.selectedOrganizationId,
    organizationIds: [ORG_ID],
  }
}

function handler<TInput, TResult>(id: string): CommandHandler<TInput, TResult> {
  const registered = commandRegistry.get(id)
  if (!registered) throw new Error(`${id} not registered`)
  return registered as CommandHandler<TInput, TResult>
}

/** Routes `findOneWithDecryption` by entity class, so each test states only the rows it cares about. */
function rows(input: { model?: ConfigurationModel | null; version?: ConfigurationModelVersion | null; sessions?: Array<ConfigurationSession | null> }) {
  const sessions = [...(input.sessions ?? [])]
  findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => {
    if (entity === ConfigurationModel) return input.model ?? null
    if (entity === ConfigurationModelVersion) return input.version ?? null
    if (entity === ConfigurationSession) return sessions.length > 1 ? sessions.shift() : (sessions[0] ?? null)
    return null
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  userHasAllFeaturesMock.mockResolvedValue(true)
  queryMock.mockResolvedValue({ items: [quoteRow()], total: 1 })
  findWithDecryptionMock.mockResolvedValue([])
})

describe('product_configurator.sessions.open', () => {
  const open = handler<SessionOpenInput, SessionOpenResult>('product_configurator.sessions.open')

  it('opens a session on the only fitting model with the quote header read at request time', async () => {
    const { em, created } = makeEm()
    findWithDecryptionMock.mockResolvedValue([model()])
    rows({ version: version() })

    const result = await open.execute({ quoteId: QUOTE_ID }, makeCtx(em))

    expect(result).toEqual({
      sessionId: SESSION_ID,
      revision: 0,
      mode: 'new',
      sourceSnapshotId: null,
      modelVersion: { id: VERSION_ID, version: 3, hash: 'f'.repeat(64), modelId: MODEL_ID, modelTitle: 'Pump' },
      quote: { id: QUOTE_ID, number: 'Q-1001', customerName: 'Acme Ltd' },
      migration: null,
    })
    expect(created[0]).toMatchObject({
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      quoteId: QUOTE_ID,
      modelVersionId: VERSION_ID,
      selections: {},
      revision: 0,
      mode: 'new',
      status: 'open',
      createdBy: USER_ID,
    })
    expect(queryMock).toHaveBeenCalledWith(
      'sales:sales_quote',
      expect.objectContaining({ tenantId: TENANT_ID, organizationId: ORG_ID, filters: { id: { $eq: QUOTE_ID } } }),
    )
    expect(findWithDecryptionMock.mock.calls[0][2]).toEqual({
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      deletedAt: null,
      currencyCode: 'EUR',
      latestVersionId: { $ne: null },
    })
    expect(userHasAllFeaturesMock).toHaveBeenCalledWith(USER_ID, ['product_configurator.sessions.manage', 'sales.quotes.view'], {
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
    })
  })

  it('answers model_required with the candidate ids when several models fit and no modelId is given', async () => {
    const { em } = makeEm()
    findWithDecryptionMock.mockResolvedValue([model(), model({ id: OTHER_MODEL_ID })])

    await expect(open.execute({ quoteId: QUOTE_ID }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'model_required', candidateIds: [MODEL_ID, OTHER_MODEL_ID] }),
    })
  })

  it('answers no_published_version when no model fits', async () => {
    const { em } = makeEm()
    await expect(open.execute({ quoteId: QUOTE_ID }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'no_published_version' }),
    })
  })

  it('opens the chosen model, and refuses one in another currency or without a published version', async () => {
    const { em } = makeEm()
    rows({ model: model(), version: version() })
    await expect(open.execute({ quoteId: QUOTE_ID, modelId: MODEL_ID }, makeCtx(em))).resolves.toMatchObject({ sessionId: SESSION_ID })

    rows({ model: model({ currencyCode: 'USD' }) })
    await expect(open.execute({ quoteId: QUOTE_ID, modelId: MODEL_ID }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'currency_mismatch', params: { modelCurrency: 'USD', quoteCurrency: 'EUR' } }),
    })

    rows({ model: model({ latestVersionId: null }) })
    await expect(open.execute({ quoteId: QUOTE_ID, modelId: MODEL_ID }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'no_published_version' }),
    })

    rows({ model: null })
    await expect(open.execute({ quoteId: QUOTE_ID, modelId: MODEL_ID }, makeCtx(em))).rejects.toMatchObject({ status: 404 })
  })

  it('answers 404 when the quote is not visible in the selected organization', async () => {
    const { em } = makeEm()
    queryMock.mockResolvedValue({ items: [], total: 0 })
    await expect(open.execute({ quoteId: QUOTE_ID }, makeCtx(em))).rejects.toMatchObject({
      status: 404,
      body: expect.objectContaining({ code: 'quote_not_found' }),
    })
  })

  it('refuses an unsupported mode or combination with mode_not_supported before reading the quote', async () => {
    const { em } = makeEm()
    const refused: SessionOpenInput[] = [
      { quoteId: QUOTE_ID, mode: 'replace' },
      { quoteId: QUOTE_ID, mode: 'duplicate' },
      { quoteId: QUOTE_ID, fromSnapshotId: SNAPSHOT_ID, mode: 'replace' },
      { quoteId: QUOTE_ID, fromSnapshotId: SNAPSHOT_ID, mode: 'new' },
    ]
    for (const input of refused) {
      await expect(open.execute(input, makeCtx(em))).rejects.toMatchObject({
        status: 400,
        body: expect.objectContaining({ code: 'mode_not_supported' }),
      })
    }
    expect(queryMock).not.toHaveBeenCalled()
  })

  describe('copy of a snapshot (duplicate)', () => {
    const choice = (key: string, label: string, values: Array<[string, string]>, order = 0): Feature => ({
      key,
      label,
      type: 'choice',
      options: values.map(([value, optionLabel], index) => ({ value, label: optionLabel, order: index })),
      default: values[0][0],
      order,
      inSummary: true,
    })
    const color = choice('color', 'Color', [['navy', 'Navy'], ['red', 'Signal red']])
    const size = choice('size', 'Size', [['s', 'Small'], ['l', 'Large']], 1)

    function definitionWith(features: Feature[]): ConfigurationDefinition {
      return { ...buildEmptyDefinition({ currencyCode: 'EUR', priceKindId: PRICE_KIND_ID }), features }
    }

    function versionRow(id: string, number: number, features: Feature[]): ConfigurationModelVersion {
      return Object.assign(version(), { id, version: number, definition: definitionWith(features) })
    }

    function snapshotRow(overrides: Partial<ConfigurationSnapshot> = {}): ConfigurationSnapshot {
      return Object.assign(new ConfigurationSnapshot(), {
        id: SNAPSHOT_ID,
        tenantId: TENANT_ID,
        organizationId: ORG_ID,
        modelVersionId: OLD_VERSION_ID,
        quoteId: QUOTE_ID,
        quoteLineId: 'abababab-abab-4bab-8bab-abababababab',
        selections: { intent: { color: 'red', size: 'l', removed: 'x' }, settled: {}, visibility: {} },
        ...overrides,
      })
    }

    function copyRows(input: { snapshot?: ConfigurationSnapshot | null; versions: ConfigurationModelVersion[]; model?: ConfigurationModel | null }) {
      findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown, where: { id?: string }) => {
        if (entity === ConfigurationSnapshot) return input.snapshot === undefined ? snapshotRow() : input.snapshot
        if (entity === ConfigurationModelVersion) return input.versions.find((row) => row.id === where.id) ?? null
        if (entity === ConfigurationModel) return input.model === undefined ? model() : input.model
        return null
      })
    }

    it('maps the copied choices onto the latest version and lists what was dropped or reset', async () => {
      const { em, created } = makeEm()
      const removedFeature = choice('removed', 'Old accessory', [['x', 'Extra']], 2)
      copyRows({
        versions: [
          versionRow(OLD_VERSION_ID, 2, [color, size, removedFeature]),
          versionRow(VERSION_ID, 3, [choice('color', 'Colour', [['navy', 'Navy']]), size]),
        ],
      })

      const result = await open.execute({ quoteId: QUOTE_ID, fromSnapshotId: SNAPSHOT_ID }, makeCtx(em))

      const migration = {
        fromVersion: { id: OLD_VERSION_ID, version: 2 },
        toVersion: { id: VERSION_ID, version: 3 },
        kept: [{ featureKey: 'size', label: 'Size', oldValue: 'l', oldDisplay: 'Large', reason: 'kept' }],
        dropped: [{ featureKey: 'removed', label: 'Old accessory', oldValue: 'x', oldDisplay: 'Extra', reason: 'feature_removed' }],
        reset: [{ featureKey: 'color', label: 'Colour', oldValue: 'red', oldDisplay: 'Signal red', reason: 'option_removed' }],
      }
      expect(result).toMatchObject({ mode: 'duplicate', sourceSnapshotId: SNAPSHOT_ID, migration })
      expect(result.modelVersion).toMatchObject({ id: VERSION_ID, version: 3, modelId: MODEL_ID })
      expect(created[0]).toMatchObject({
        mode: 'duplicate',
        sourceSnapshotId: SNAPSHOT_ID,
        modelVersionId: VERSION_ID,
        selections: { size: 'l' },
        migration,
        revision: 0,
        status: 'open',
      })
    })

    it('copies the intent as is when the snapshot is on the latest version', async () => {
      const { em, created } = makeEm()
      copyRows({
        snapshot: snapshotRow({ modelVersionId: VERSION_ID, selections: { intent: { color: 'red' }, settled: {}, visibility: {} } }),
        versions: [versionRow(VERSION_ID, 3, [color, size])],
      })

      const result = await open.execute({ quoteId: QUOTE_ID, fromSnapshotId: SNAPSHOT_ID, mode: 'duplicate' }, makeCtx(em))

      expect(result).toMatchObject({ mode: 'duplicate', sourceSnapshotId: SNAPSHOT_ID, migration: null })
      expect(created[0]).toMatchObject({ selections: { color: 'red' }, migration: null })
    })

    it('answers snapshot_not_in_quote for a snapshot of another quote, an unknown one, or another model', async () => {
      const { em } = makeEm()
      const versions = [versionRow(OLD_VERSION_ID, 2, [color]), versionRow(VERSION_ID, 3, [color])]
      const refusals: Array<{ snapshot: ConfigurationSnapshot | null; modelId?: string }> = [
        { snapshot: snapshotRow({ quoteId: OTHER_QUOTE_ID }) },
        { snapshot: null },
        { snapshot: snapshotRow(), modelId: OTHER_MODEL_ID },
      ]
      for (const refusal of refusals) {
        copyRows({ snapshot: refusal.snapshot, versions })
        await expect(
          open.execute({ quoteId: QUOTE_ID, fromSnapshotId: SNAPSHOT_ID, modelId: refusal.modelId }, makeCtx(em)),
        ).rejects.toMatchObject({ status: 422, body: expect.objectContaining({ code: 'snapshot_not_in_quote' }) })
      }
      expect(findOneWithDecryptionMock.mock.calls[0][2]).toEqual({ id: SNAPSHOT_ID, tenantId: TENANT_ID, organizationId: ORG_ID })
    })

    it("refuses a copy whose model was deleted or no longer matches the quote currency", async () => {
      const { em } = makeEm()
      const versions = [versionRow(OLD_VERSION_ID, 2, [color]), versionRow(VERSION_ID, 3, [color])]
      copyRows({ versions, model: null })
      await expect(open.execute({ quoteId: QUOTE_ID, fromSnapshotId: SNAPSHOT_ID }, makeCtx(em))).rejects.toMatchObject({
        status: 404,
        body: expect.objectContaining({ code: 'model_not_found' }),
      })
      copyRows({ versions, model: model({ currencyCode: 'USD' }) })
      await expect(open.execute({ quoteId: QUOTE_ID, fromSnapshotId: SNAPSHOT_ID }, makeCtx(em))).rejects.toMatchObject({
        status: 409,
        body: expect.objectContaining({ code: 'currency_mismatch' }),
      })
    })
  })

  it('needs sales visibility of quotes and a single selected organization', async () => {
    const { em } = makeEm()
    userHasAllFeaturesMock.mockResolvedValue(false)
    await expect(open.execute({ quoteId: QUOTE_ID }, makeCtx(em))).rejects.toMatchObject({ status: 403 })
    await expect(open.execute({ quoteId: QUOTE_ID }, makeCtx(em, { selectedOrganizationId: null }))).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ code: 'organization_scope_required' }),
    })
  })

  it('writes an audit entry', async () => {
    const log = await open.buildLog?.({
      input: { quoteId: QUOTE_ID },
      result: {
        sessionId: SESSION_ID,
        revision: 0,
        mode: 'duplicate',
        sourceSnapshotId: SNAPSHOT_ID,
        modelVersion: { id: VERSION_ID, version: 3, hash: 'h', modelId: MODEL_ID, modelTitle: 'Pump' },
        quote: { id: QUOTE_ID, number: 'Q-1001', customerName: null },
        migration: null,
      },
      ctx: makeCtx(makeEm().em),
      snapshots: {},
    })
    expect(log).toMatchObject({
      resourceKind: 'product_configurator.session',
      resourceId: SESSION_ID,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      snapshotAfter: expect.objectContaining({ mode: 'duplicate', sourceSnapshotId: SNAPSHOT_ID, migrated: false }),
    })
    expect(open.isUndoable).toBe(false)
  })
})

describe('product_configurator.sessions.evaluate', () => {
  const evaluate = handler<SessionEvaluateInput, SessionEvaluateResult>('product_configurator.sessions.evaluate')
  const evaluation = { netPrice: '10.00', hash: 'e'.repeat(64), finalisable: true }

  it('prices with the quote channel and customer, stores the intent and the result and bumps the revision', async () => {
    const { em } = makeEm()
    const stored = session()
    rows({ version: version(), sessions: [session(), stored] })
    evaluateConfigurationMock.mockResolvedValue(evaluation)

    const result = await evaluate.execute({ id: SESSION_ID, revision: 2, selections: { size: 'l', color: null } }, makeCtx(em))

    expect(result).toEqual({ id: SESSION_ID, status: 'open', revision: 3, selections: { size: 'l' }, evaluation })
    expect(stored).toMatchObject({ revision: 3, selections: { size: 'l' }, evaluation })
    const call = evaluateConfigurationMock.mock.calls[0][0]
    expect(call).toMatchObject({
      modelVersion: { id: VERSION_ID, hash: 'f'.repeat(64) },
      selections: { size: 'l', color: null },
      pricing: { channelId: CHANNEL_ID, customerId: CUSTOMER_ID, scope: { tenantId: TENANT_ID, organizationId: ORG_ID } },
    })
    expect(call.pricing.at).toBeInstanceOf(Date)
    const lockCall = findOneWithDecryptionMock.mock.calls.find((args) => args[1] === ConfigurationSession && args[3]?.lockMode)
    expect(lockCall?.[3]).toMatchObject({ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })
  })

  it('answers session_changed with the current state for a stale revision, before evaluating', async () => {
    const { em } = makeEm()
    rows({ sessions: [session({ revision: 5 })] })
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: {} }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'session_changed', session: expect.objectContaining({ revision: 5, selections: { size: 's' } }) }),
    })
    expect(evaluateConfigurationMock).not.toHaveBeenCalled()
  })

  it('answers session_changed when another evaluate stored a revision while this one was computed', async () => {
    const { em } = makeEm()
    rows({ version: version(), sessions: [session(), session({ revision: 3 })] })
    evaluateConfigurationMock.mockResolvedValue(evaluation)
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: {} }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'session_changed' }),
    })
    expect(em.flush).not.toHaveBeenCalled()
  })

  it('answers session_not_open for a cancelled session and 404 for an unknown one', async () => {
    const { em } = makeEm()
    rows({ sessions: [session({ status: 'cancelled' })] })
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: {} }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'session_not_open', status: 'cancelled' }),
    })
    rows({ sessions: [] })
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: {} }, makeCtx(em))).rejects.toMatchObject({ status: 404 })
  })

  it('maps evaluation errors to 422 with their code, params and issues and stores nothing', async () => {
    const { em } = makeEm()
    rows({ version: version(), sessions: [session()] })
    evaluateConfigurationMock.mockRejectedValue(
      new ConfiguratorEvaluationError('invalid_selection', {}, [{ featureKey: 'size', reason: 'not_an_option', value: 'xl' }]),
    )
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: { size: 'xl' } }, makeCtx(em))).rejects.toMatchObject({
      status: 422,
      body: expect.objectContaining({ code: 'invalid_selection', issues: [{ featureKey: 'size', reason: 'not_an_option', value: 'xl' }] }),
    })
    evaluateConfigurationMock.mockRejectedValue(new ConfiguratorEvaluationError('price_missing', { skus: ['PART-1'], channelId: null }))
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: {} }, makeCtx(em))).rejects.toMatchObject({
      status: 422,
      body: expect.objectContaining({ code: 'price_missing', params: { skus: ['PART-1'], channelId: null } }),
    })
    expect(em.flush).not.toHaveBeenCalled()
  })

  it('answers currency_mismatch when the quote currency no longer matches the model, and 404 when the quote is gone', async () => {
    const { em } = makeEm()
    rows({ version: version('USD'), sessions: [session()] })
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: {} }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'currency_mismatch' }),
    })
    queryMock.mockResolvedValue({ items: [], total: 0 })
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: {} }, makeCtx(em))).rejects.toMatchObject({
      status: 404,
      body: expect.objectContaining({ code: 'quote_not_found' }),
    })
  })

  it('needs sales visibility of quotes', async () => {
    const { em } = makeEm()
    userHasAllFeaturesMock.mockResolvedValue(false)
    await expect(evaluate.execute({ id: SESSION_ID, revision: 2, selections: {} }, makeCtx(em))).rejects.toMatchObject({ status: 403 })
    expect(findOneWithDecryptionMock).not.toHaveBeenCalled()
  })
})

describe('product_configurator.sessions.cancel', () => {
  const cancel = handler<SessionIdInput, SessionCancelResult>('product_configurator.sessions.cancel')

  it('cancels an open session under a row lock', async () => {
    const { em } = makeEm()
    const locked = session()
    rows({ sessions: [locked] })
    await expect(cancel.execute({ id: SESSION_ID }, makeCtx(em))).resolves.toEqual({ id: SESSION_ID, status: 'cancelled' })
    expect(locked.status).toBe('cancelled')
    expect(findOneWithDecryptionMock.mock.calls[0][3]).toMatchObject({ lockMode: LockMode.PESSIMISTIC_WRITE })
  })

  it('answers session_not_open for a session that is not open', async () => {
    const { em } = makeEm()
    rows({ sessions: [session({ status: 'finalised' })] })
    await expect(cancel.execute({ id: SESSION_ID }, makeCtx(em))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'session_not_open', status: 'finalised' }),
    })
  })
})
