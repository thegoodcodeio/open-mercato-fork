import { TextEncoder } from 'node:util'
import { build } from '../../../lib/__tests__/fixtures'
import type { WorkspaceEvaluation } from '../evaluationSchema'
import {
  changedChoices,
  convertedOrderLookupUrl,
  convertedQuoteLinkFromResponse,
  evaluateOutcomeFromResponse,
  finaliseOutcomeFromResponse,
  migrationChanges,
  quoteHref,
  sessionLoadFromResponse,
} from '../session/sessionApi'

Object.assign(globalThis, { TextEncoder })

const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const QUOTE_ID = '33333333-3333-4333-8333-333333333333'

function evaluation(overrides: Partial<WorkspaceEvaluation> = {}): WorkspaceEvaluation {
  return {
    selections: { motor: 'standard' },
    visibility: { motor: true },
    forced: [],
    availability: {},
    errors: [],
    warnings: [],
    surcharges: [],
    finalisable: true,
    bom: [],
    netPrice: '100.00',
    currencyCode: 'EUR',
    hash: 'h1',
    ...overrides,
  }
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    status: 'open',
    mode: 'new',
    revision: 3,
    quoteId: QUOTE_ID,
    quote: { id: QUOTE_ID, number: 'SQ-1', customerName: 'Acme', currencyCode: 'EUR' },
    modelVersion: { id: 'v1', version: 2, hash: 'x', modelId: 'm1', modelTitle: 'Pump', definition: build() },
    selections: { motor: 'heavy', ignored: { nested: true } },
    evaluation: evaluation(),
    migration: null,
    createdBy: null,
    createdAt: '2026-11-06T10:00:00.000Z',
    updatedAt: '2026-11-06T10:00:00.000Z',
    ...overrides,
  }
}

describe('session API mapping', () => {
  it('reads a session detail, keeps only selection values and parses the definition', () => {
    const load = sessionLoadFromResponse(200, detail())
    expect(load.status).toBe('ready')
    if (load.status !== 'ready') return
    expect(load.session.selections).toEqual({ motor: 'heavy' })
    expect(load.session.modelVersion.definition.features.length).toBeGreaterThan(0)
    expect(load.session.evaluation?.hash).toBe('h1')
  })

  it('maps load failures to page states, and a broken definition to an error rather than an empty workspace', () => {
    expect(sessionLoadFromResponse(404, {})).toEqual({ status: 'not_found' })
    expect(sessionLoadFromResponse(403, {})).toEqual({ status: 'forbidden' })
    expect(sessionLoadFromResponse(400, { code: 'organization_scope_required' })).toEqual({ status: 'organization_required' })
    expect(sessionLoadFromResponse(200, detail({ modelVersion: { id: 'v1', version: 1, modelTitle: null, definition: { nope: true } } }))).toEqual({
      status: 'error',
    })
  })

  it('returns the next revision of a stored evaluation', () => {
    expect(evaluateOutcomeFromResponse(200, { id: SESSION_ID, revision: 4, evaluation: evaluation() }, {})).toMatchObject({ ok: true, revision: 4 })
  })

  it('keeps the refused choices next to the current state on session_changed', () => {
    const current = { id: SESSION_ID, status: 'open', revision: 7, selections: { motor: 'standard' }, evaluation: evaluation() }
    const outcome = evaluateOutcomeFromResponse(409, { code: 'session_changed', session: current }, { motor: 'heavy' })
    expect(outcome).toEqual({ ok: false, failure: { kind: 'session_changed', session: current, rejected: { motor: 'heavy' } } })
  })

  it('maps session_not_open, deterministic and transient evaluate failures', () => {
    expect(evaluateOutcomeFromResponse(409, { code: 'session_not_open', status: 'cancelled' }, {})).toEqual({
      ok: false,
      failure: { kind: 'session_not_open', status: 'cancelled' },
    })
    expect(evaluateOutcomeFromResponse(422, { code: 'price_missing', params: { skus: ['A'], channelId: null } }, {})).toEqual({
      ok: false,
      failure: { kind: 'price_missing', skus: ['A'], channelId: null },
    })
    expect(evaluateOutcomeFromResponse(503, {}, {})).toEqual({ ok: false, failure: { kind: 'transient' } })
  })

  it.each([
    [200, { snapshotId: 's', quoteLineId: 'l', hash: 'h', replay: true }, { kind: 'added', snapshotId: 's', quoteLineId: 'l', replay: true }],
    [
      200,
      { snapshotId: 's', quoteLineId: 'l', hash: 'h', replay: false, outcome: 'added' },
      { kind: 'added', snapshotId: 's', quoteLineId: 'l', replay: false },
    ],
    [
      200,
      { snapshotId: 's', quoteLineId: 'l', hash: 'h-earlier', replay: false, outcome: 'added_with_earlier_choices' },
      { kind: 'added_with_earlier_choices', snapshotId: 's' },
    ],
    [409, { code: 'finalise_in_progress' }, { kind: 'in_progress' }],
    [409, { code: 'finalise_busy' }, { kind: 'busy' }],
    [409, { code: 'quote_changed' }, { kind: 'quote_changed' }],
    [409, { code: 'quote_converted' }, { kind: 'quote_converted' }],
    [409, { code: 'session_not_open', status: 'cancelled' }, { kind: 'session_not_open', status: 'cancelled' }],
    [409, { code: 'model_deleted' }, { kind: 'cannot_add', code: 'model_deleted' }],
    [409, { code: 'currency_mismatch' }, { kind: 'cannot_add', code: 'currency_mismatch' }],
    [422, { code: 'product_missing' }, { kind: 'cannot_add', code: 'product_missing' }],
    [502, { code: 'quote_line_write_failed', status: 'open' }, { kind: 'write_failed', status: 'open' }],
    [502, { code: 'quote_line_write_failed', status: 'finalising' }, { kind: 'write_failed', status: 'finalising' }],
    [502, { code: 'quote_line_write_failed' }, { kind: 'write_failed', status: null }],
    [502, null, { kind: 'write_failed', status: null }],
    [500, {}, { kind: 'transient' }],
    [422, { code: 'blocked', error: 'Blocked by a guard' }, { kind: 'other', message: 'Blocked by a guard' }],
  ])('maps finalise %s %j', (status, body, expected) => {
    expect(finaliseOutcomeFromResponse(status, body)).toEqual(expected)
  })

  it('returns the new result with result_changed and not_finalisable, and the session with session_changed', () => {
    const result = evaluation({ netPrice: '120.00', hash: 'h2' })
    expect(finaliseOutcomeFromResponse(409, { code: 'result_changed', result: { ...result, summary: 'x' } })).toEqual({ kind: 'result_changed', result })
    expect(finaliseOutcomeFromResponse(422, { code: 'not_finalisable', result })).toEqual({ kind: 'not_finalisable', result })
    const session = { id: SESSION_ID, status: 'open', revision: 9, selections: {}, evaluation: null }
    expect(finaliseOutcomeFromResponse(409, { code: 'session_changed', session })).toEqual({ kind: 'session_changed', session })
    expect(finaliseOutcomeFromResponse(422, { code: 'expression_error', params: { formulaKey: 'f' } })).toEqual({
      kind: 'evaluation',
      failure: { kind: 'model_fix', code: 'expression_error', params: { formulaKey: 'f' } },
    })
  })

  it('lists the fields that differ between what the rep would see and the current state', () => {
    const definition = build()
    const [first, second, third] = definition.features.map((feature) => feature.key)
    const rows = changedChoices(definition, {
      rejected: { [first]: 'a' },
      shown: { [first]: 'x', [second]: 'kept', [third]: 'seen' },
      session: {
        id: SESSION_ID,
        status: 'open',
        revision: 2,
        selections: { [first]: 'b' },
        evaluation: evaluation({ selections: { [first]: 'b', [second]: 'kept', [third]: 'forced' } }),
      },
    })
    expect(rows).toEqual([
      { featureKey: first, label: definition.features[0].label, yours: 'a', current: 'b' },
      { featureKey: third, label: definition.features[2].label, yours: 'seen', current: 'forced' },
    ])
  })

  it('links back to the quote with the configured line to highlight', () => {
    expect(quoteHref(QUOTE_ID)).toBe(`/backend/sales/quotes/${QUOTE_ID}`)
    expect(quoteHref(QUOTE_ID, 'snap')).toBe(`/backend/sales/quotes/${QUOTE_ID}?configuredLine=snap`)
  })

  it('links a converted quote to its order, else to the orders list, else (no order access) to the quotes list', () => {
    expect(convertedOrderLookupUrl(QUOTE_ID)).toBe(`/api/sales/orders?id=${QUOTE_ID}&pageSize=1`)
    expect(convertedQuoteLinkFromResponse(200, { items: [{ id: QUOTE_ID, orderNumber: 'SO-1' }] }, QUOTE_ID)).toEqual({
      kind: 'order',
      href: `/backend/sales/orders/${QUOTE_ID}`,
    })
    expect(convertedQuoteLinkFromResponse(200, { items: [] }, QUOTE_ID)).toEqual({ kind: 'orders', href: '/backend/sales/orders' })
    expect(convertedQuoteLinkFromResponse(403, { error: 'Forbidden' }, QUOTE_ID)).toEqual({ kind: 'quotes', href: '/backend/sales/quotes' })
    expect(convertedQuoteLinkFromResponse(200, { unexpected: true }, QUOTE_ID)).toEqual({ kind: 'quotes', href: '/backend/sales/quotes' })
  })

  describe('copies', () => {
    const migration = {
      fromVersion: { id: 'v1', version: 1 },
      toVersion: { id: 'v2', version: 2 },
      kept: [{ featureKey: 'motor', label: 'Motor', oldValue: 'heavy', oldDisplay: 'Heavy', reason: 'kept' }],
      dropped: [{ featureKey: 'hose', label: 'Hose', oldValue: 'long', oldDisplay: 'Long', reason: 'feature_removed' }],
      reset: [{ featureKey: 'color', label: 'Colour', oldValue: 'green', oldDisplay: 'Green', reason: 'option_removed' }],
    }

    it('reads the copy source and the migration of a copied session, and defaults them for a new one', () => {
      const copy = sessionLoadFromResponse(200, detail({ mode: 'duplicate', sourceSnapshotId: 'snap-1', sourceLineName: 'Pump (farm)', migration }))
      expect(copy.status === 'ready' && copy.session).toMatchObject({ mode: 'duplicate', sourceSnapshotId: 'snap-1', sourceLineName: 'Pump (farm)', migration })
      const fresh = sessionLoadFromResponse(200, detail({ mode: undefined, migration: undefined }))
      expect(fresh.status === 'ready' && fresh.session).toMatchObject({ mode: 'new', sourceSnapshotId: null, sourceLineName: null, migration: null })
    })

    it('lists only the choices that moved', () => {
      expect(migrationChanges(null)).toEqual([])
      expect(migrationChanges(migration).map((item) => item.featureKey)).toEqual(['color', 'hose'])
    })

    it('maps migration_unconfirmed to the copy review with the migration to show', () => {
      expect(finaliseOutcomeFromResponse(422, { code: 'migration_unconfirmed', migration })).toEqual({ kind: 'migration_unconfirmed', migration })
      expect(finaliseOutcomeFromResponse(422, { code: 'migration_unconfirmed' })).toEqual({ kind: 'migration_unconfirmed', migration: null })
    })
  })
})
