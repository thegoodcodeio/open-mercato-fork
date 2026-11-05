import { DEFINITION_LIMITS, definitionSchema } from '../../data/validators'
import { hashDefinition } from '../hash'
import { buildEmptyDefinition, computeDraftHash, findDraftProblem } from '../modelDraft'

const PRICE_KIND_ID = '55555555-5555-4555-8555-555555555555'

describe('model draft rules', () => {
  const skeleton = buildEmptyDefinition({ currencyCode: 'EUR', priceKindId: PRICE_KIND_ID })

  it('builds a skeleton that passes the definition schema', () => {
    expect(definitionSchema.safeParse(skeleton).success).toBe(true)
  })

  it('hashes a valid draft like a published version, so an unchanged draft has no unpublished changes', () => {
    expect(computeDraftHash(skeleton)).toBe(hashDefinition(definitionSchema.parse(skeleton)))
  })

  it('still hashes a draft that breaks the schema', () => {
    const broken = { ...skeleton, features: [{ key: 'x' }] }
    expect(computeDraftHash(broken)).toMatch(/^[0-9a-f]{64}$/)
    expect(computeDraftHash(broken)).not.toBe(computeDraftHash(skeleton))
  })

  it('accepts a schema-invalid draft but rejects a changed currency, oversize and deep nesting', () => {
    expect(findDraftProblem({ ...skeleton, features: [{ key: 'x' }] }, 'EUR')).toBeNull()
    expect(findDraftProblem(skeleton, 'USD')).toBe('currency_code_mismatch')
    expect(findDraftProblem({ ...skeleton, padding: 'x'.repeat(DEFINITION_LIMITS.definitionBytes) }, 'EUR')).toBe('too_large')
    let nested: Record<string, unknown> = {}
    for (let depth = 0; depth < DEFINITION_LIMITS.jsonNestingDepth + 1; depth += 1) nested = { child: nested }
    expect(findDraftProblem({ ...skeleton, nested }, 'EUR')).toBe('too_deep')
  })
})
