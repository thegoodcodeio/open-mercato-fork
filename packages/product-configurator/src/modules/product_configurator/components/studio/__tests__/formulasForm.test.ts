import { build } from '../../../lib/__tests__/fixtures'
import {
  FORMULA_ERROR_KEYS,
  formatPreview,
  formToFormula,
  formulaReferenceKeys,
  formulaToForm,
  previewCandidate,
  previewFormulas,
} from '../tabs/formulas/formulaForm'

describe('formula row editor form', () => {
  const definition = build()

  it('round-trips every formula of the reference model through the text syntax', () => {
    for (const formula of definition.formulas) {
      const result = formToFormula(formulaToForm(formula), [], formulaReferenceKeys(definition, formula.key))
      expect(result).toEqual({ ok: true, formula })
    }
  })

  it('builds a formula with optional fields left out when empty', () => {
    const values = { label: ' ', key: 'double_length', expression: 'feature.length * 2', unit: '', decimals: '' }
    const result = formToFormula(values, [], formulaReferenceKeys(definition, undefined))
    expect(result).toEqual({
      ok: true,
      formula: {
        key: 'double_length',
        expr: { kind: 'op', op: '*', left: { kind: 'feature', featureKey: 'length' }, right: { kind: 'const', value: 2 } },
      },
    })
  })

  it('reports key errors and the parse error instead of building an invalid formula', () => {
    const values = { label: 'Copy', key: 'weight', expression: 'lookup.motor_weigth * 2', unit: 'kg', decimals: '2' }
    const result = formToFormula(values, ['weight'], formulaReferenceKeys(definition, undefined))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual({ key: FORMULA_ERROR_KEYS.duplicateKey })
    expect(result.expressionError).toMatchObject({ code: 'unknown_reference', params: { namespace: 'lookup', key: 'motor_weigth' } })
  })

  it('rejects a key the schema does not allow and decimals outside 0-6', () => {
    const values = { label: '', key: 'constructor', expression: '1', unit: '', decimals: '7' }
    expect(formToFormula(values, [], formulaReferenceKeys(definition, undefined))).toEqual({
      ok: false,
      errors: { decimals: FORMULA_ERROR_KEYS.decimals },
      expressionError: null,
    })
    expect(formToFormula({ ...values, decimals: '' }, [], formulaReferenceKeys(definition, undefined))).toEqual({
      ok: false,
      errors: { key: FORMULA_ERROR_KEYS.invalidKey },
      expressionError: null,
    })
  })

  it('does not let a formula read itself', () => {
    const keys = formulaReferenceKeys(definition, 'weight')
    expect(keys.formula.has('weight')).toBe(false)
    expect(keys.formula.has('pipe_meters')).toBe(true)
  })
})

describe('formula previews', () => {
  it('computes every formula with the model defaults', () => {
    const previews = previewFormulas(build())
    expect(previews.get('pipe_meters')).toBe(2.25)
    expect(previews.get('weight')).toBe(80)
  })

  it('keeps the other previews when one formula cannot be computed', () => {
    const definition = build((input) => {
      input.formulas.push({
        key: 'broken',
        expr: { kind: 'op', op: '/', left: { kind: 'const', value: 1 }, right: { kind: 'const', value: 0 } },
      })
    })
    const previews = previewFormulas(definition)
    expect(previews.get('broken')).toBeNull()
    expect(previews.get('weight')).toBe(80)
  })

  it('previews a candidate in place of the formula it edits', () => {
    const definition = build()
    const candidate = { key: 'weight', expr: { kind: 'lookup' as const, lookupKey: 'motor_weight' }, decimals: 0 }
    expect(previewCandidate(definition, candidate, 'weight')).toBe(40)
    expect(previewCandidate(definition, { ...candidate, key: 'new_one' }, undefined)).toBe(40)
  })

  it('formats with decimals and unit, or a dash when there is no value', () => {
    expect(formatPreview(1, 1, 'm')).toBe('1.0 m')
    expect(formatPreview(86.333, 2, 'kNm')).toBe('86.33 kNm')
    expect(formatPreview(2.5, undefined, undefined)).toBe('2.5')
    expect(formatPreview(null, 1, 'm')).toBe('—')
  })
})
