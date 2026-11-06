/** @jest-environment node */
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands/types'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { ConfigurationModel, ConfigurationModelVersion } from '../../data/entities'
import type { SessionFinaliseInput } from '../../data/validators'
import { FinaliseFailure, type ConfiguredLineBody, type FinaliseResult, type FinaliseSession } from '../../lib/finalise'
import { isTrustedFinaliseRequest } from '../../lib/lineGuard'
import { buildEmptyDefinition } from '../../lib/modelDraft'
import type { QuoteHeader } from '../../lib/quoteAccess'
import { createFinaliseDeps, finaliseFailed } from '../finalise'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'
const MODEL_ID = '44444444-4444-4444-8444-444444444444'
const VERSION_ID = '66666666-6666-4666-8666-666666666666'
const SESSION_ID = '77777777-7777-4777-8777-777777777777'
const USER_ID = '88888888-8888-4888-8888-888888888888'
const PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PRICE_KIND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TAX_RATE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const findOneWithDecryptionMock = jest.fn()
const evaluateConfigurationMock = jest.fn()
const finaliseSessionMock = jest.fn()
const userHasAllFeaturesMock = jest.fn()
const resolveProductsMock = jest.fn()
const executeMock = jest.fn()

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback?: string) => fallback ?? _key }),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: async () => [],
}))

jest.mock('../../lib/evaluation', () => ({
  evaluateConfiguration: (...args: unknown[]) => evaluateConfigurationMock(...args),
}))

jest.mock('../../lib/finalise', () => ({
  ...jest.requireActual('../../lib/finalise'),
  finaliseSession: (...args: unknown[]) => finaliseSessionMock(...args),
}))

const em = { fork: () => em }

function makeCtx(): CommandRuntimeContext {
  return {
    container: {
      resolve: (token: string) => {
        if (token === 'em') return em
        if (token === 'rbacService') return { userHasAllFeatures: userHasAllFeaturesMock }
        if (token === 'catalogPriceRowService') return { resolveProducts: resolveProductsMock }
        if (token === 'commandBus') return { execute: executeMock }
        throw new Error(`Could not resolve ${token}`)
      },
    } as unknown as CommandRuntimeContext['container'],
    auth: { sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID } as CommandRuntimeContext['auth'],
    organizationScope: null,
    selectedOrganizationId: ORG_ID,
    organizationIds: [ORG_ID],
    request: new Request('http://localhost/api/product_configurator/sessions/finalise'),
  }
}

const scope = { tenantId: TENANT_ID, organizationId: ORG_ID }

const session: FinaliseSession = {
  id: SESSION_ID,
  tenantId: TENANT_ID,
  organizationId: ORG_ID,
  quoteId: QUOTE_ID,
  modelVersionId: VERSION_ID,
  revision: 2,
  status: 'finalising',
  selections: { size: 's' },
}

function quote(currencyCode = 'EUR'): QuoteHeader {
  return {
    id: QUOTE_ID,
    organizationId: ORG_ID,
    quoteNumber: 'Q-1',
    status: 'draft',
    currencyCode,
    channelId: null,
    customerEntityId: null,
    customerName: null,
    updatedAt: '2026-11-06T09:00:00.000Z',
  }
}

function rows(input: { model?: Partial<ConfigurationModel> | null }) {
  findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => {
    if (entity === ConfigurationModelVersion) {
      return Object.assign(new ConfigurationModelVersion(), {
        id: VERSION_ID,
        modelId: MODEL_ID,
        version: 1,
        hash: 'f'.repeat(64),
        definition: buildEmptyDefinition({ currencyCode: 'EUR', priceKindId: PRICE_KIND_ID }),
      })
    }
    if (entity === ConfigurationModel) {
      return input.model === null ? null : Object.assign(new ConfigurationModel(), { id: MODEL_ID, productId: PRODUCT_ID, title: 'Pump', deletedAt: null, ...input.model })
    }
    return null
  })
}

async function httpErrorOf(promise: Promise<unknown>): Promise<CrudHttpError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof CrudHttpError)) throw new Error(`expected CrudHttpError, got ${String(error)}`)
  return error
}

beforeEach(() => {
  jest.clearAllMocks()
  userHasAllFeaturesMock.mockResolvedValue(true)
  resolveProductsMock.mockResolvedValue(new Map([[PRODUCT_ID, { productId: PRODUCT_ID, sku: null, title: 'Pump', taxRateId: TAX_RATE_ID }]]))
  evaluateConfigurationMock.mockResolvedValue({ hash: 'h', netPrice: '10.00', finalisable: true })
  rows({})
})

describe('product_configurator.sessions.finalise', () => {
  const handler = commandRegistry.get('product_configurator.sessions.finalise') as CommandHandler<SessionFinaliseInput, FinaliseResult>

  it('needs sales.quotes.manage on top of the configurator grant', async () => {
    userHasAllFeaturesMock.mockResolvedValue(false)
    const error = await httpErrorOf(Promise.resolve(handler.execute({ id: SESSION_ID, expectedHash: 'h', revision: 0 }, makeCtx())))
    expect(error.status).toBe(403)
    expect(userHasAllFeaturesMock).toHaveBeenCalledWith(USER_ID, ['product_configurator.sessions.manage', 'sales.quotes.manage'], scope)
    expect(finaliseSessionMock).not.toHaveBeenCalled()
  })

  it('maps refusals to their HTTP status, code and details', async () => {
    finaliseSessionMock.mockRejectedValue(new FinaliseFailure('result_changed', { result: { hash: 'new' } }))
    const error = await httpErrorOf(Promise.resolve(handler.execute({ id: SESSION_ID, expectedHash: 'h', revision: 0 }, makeCtx())))
    expect(error.status).toBe(409)
    expect(error.body).toMatchObject({ code: 'result_changed', result: { hash: 'new' } })
  })

  it.each([
    ['session_not_open', 409],
    ['finalise_in_progress', 409],
    ['finalise_busy', 409],
    ['session_changed', 409],
    ['quote_changed', 409],
    ['quote_converted', 409],
    ['migration_unconfirmed', 422],
    ['not_finalisable', 422],
    ['quote_line_write_failed', 502],
    ['session_not_found', 404],
  ] as const)('%s answers %i', async (code, status) => {
    expect((await finaliseFailed(new FinaliseFailure(code))).status).toBe(status)
  })
})

describe('finalise audit', () => {
  const handler = commandRegistry.get('product_configurator.sessions.finalise') as CommandHandler<SessionFinaliseInput, FinaliseResult>
  const input = { id: SESSION_ID, expectedHash: 'h', revision: 0 }
  const added = { snapshotId: VERSION_ID, quoteLineId: MODEL_ID, hash: 'h' }

  it.each(['added', 'added_with_earlier_choices'] as const)('logs the finalise that ended with outcome %s', async (outcome) => {
    const log = await handler.buildLog!({ input, result: { ...added, replay: false, outcome }, ctx: makeCtx(), snapshots: {} })
    expect(log).toMatchObject({ resourceId: SESSION_ID, snapshotAfter: { status: 'finalised', ...added, outcome } })
    expect(log).not.toHaveProperty('skipLog')
  })

  it('writes no second audit entry for a replay', async () => {
    await expect(
      handler.buildLog!({ input, result: { ...added, replay: true, outcome: 'added' }, ctx: makeCtx(), snapshots: {} }),
    ).resolves.toEqual({ skipLog: true })
  })
})

describe('createFinaliseDeps', () => {
  it('prepares with the bound product tax rate and the model title', async () => {
    const prepared = await createFinaliseDeps(makeCtx(), scope).prepare(session, quote())
    expect(prepared).toMatchObject({ modelTitle: 'Pump', productId: PRODUCT_ID, taxRateId: TAX_RATE_ID, modelVersionHash: 'f'.repeat(64) })
    expect(resolveProductsMock).toHaveBeenCalledWith(em, [PRODUCT_ID], scope)
  })

  it('refuses a deleted model with 409 model_deleted', async () => {
    rows({ model: { deletedAt: new Date() } })
    const error = await httpErrorOf(createFinaliseDeps(makeCtx(), scope).prepare(session, quote()))
    expect(error.status).toBe(409)
    expect(error.body.code).toBe('model_deleted')
    expect(evaluateConfigurationMock).not.toHaveBeenCalled()
  })

  it('refuses a missing bound product with 422 product_missing', async () => {
    resolveProductsMock.mockResolvedValue(new Map())
    const error = await httpErrorOf(createFinaliseDeps(makeCtx(), scope).prepare(session, quote()))
    expect(error.status).toBe(422)
    expect(error.body.code).toBe('product_missing')
  })

  it('refuses a quote whose currency no longer matches', async () => {
    const error = await httpErrorOf(createFinaliseDeps(makeCtx(), scope).prepare(session, quote('USD')))
    expect(error.status).toBe(409)
    expect(error.body.code).toBe('currency_mismatch')
  })

  it('writes the line through the sales command with a trusted request carrying the quote lock token', async () => {
    executeMock.mockResolvedValue({ result: { quoteId: QUOTE_ID, lineId: 'line-1' } })
    const ctx = makeCtx()
    const body = { quoteId: QUOTE_ID } as ConfiguredLineBody
    await expect(createFinaliseDeps(ctx, scope).sales.writeLine(body, '2026-11-06T09:00:00.000Z')).resolves.toBe('line-1')

    const [commandId, options] = executeMock.mock.calls[0] as [string, { input: unknown; ctx: CommandRuntimeContext }]
    expect(commandId).toBe('sales.quotes.lines.upsert')
    expect(options.input).toEqual({ body })
    expect(options.ctx.auth).toBe(ctx.auth)
    expect(options.ctx.selectedOrganizationId).toBe(ORG_ID)
    expect(options.ctx.request).not.toBe(ctx.request)
    expect(isTrustedFinaliseRequest(options.ctx.request)).toBe(true)
    expect(isTrustedFinaliseRequest(ctx.request)).toBe(false)
    expect(options.ctx.request?.headers.get(OPTIMISTIC_LOCK_HEADER_NAME)).toBe('2026-11-06T09:00:00.000Z')
  })
})
