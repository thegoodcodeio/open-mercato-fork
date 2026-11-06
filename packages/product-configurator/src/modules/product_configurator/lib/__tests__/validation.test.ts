import { DEFINITION_LIMITS, type ConfigurationDefinitionInput, type Expression } from '../../data/validators'
import { VALIDATION_CHECKS, VALIDATION_CHECK_LABEL_KEYS, VALIDATION_CODES, VALIDATION_MESSAGE_KEYS, validateForPublication } from '../validation'
import en from '../../i18n/en.json'
import { choiceFeature, referenceInput, setRule } from './fixtures'
import { catalogItem, codesOf, fakeCatalog, PRODUCT_ID, validate } from './validationFixtures'

type RuleInput = ConfigurationDefinitionInput['rules'][number]

function nested(depth: number): Expression {
  let expression: Expression = { kind: 'const', value: 1 }
  for (let level = 1; level < depth; level += 1) {
    expression = { kind: 'op', op: '+', left: expression, right: { kind: 'const', value: 1 } }
  }
  return expression
}

function rule(id: string, effect: RuleInput['effect'], messageTemplate: string, order = 1): RuleInput {
  return { id, effect, when: [], messageTemplate, featureKeys: [], order }
}

function valueLookup(input: ConfigurationDefinitionInput, key: string) {
  const lookup = input.lookups.find((entry) => entry.key === key)
  if (lookup?.kind !== 'value') throw new Error(`fixture has no value lookup ${key}`)
  return lookup
}

describe('validateForPublication', () => {
  it('passes the reference definition', async () => {
    expect(await validate()).toEqual({ ok: true, issues: [] })
  })

  it('has an i18n message for every code and a label for every check', () => {
    const dictionary: Record<string, string> = en
    for (const code of VALIDATION_CODES) expect(dictionary[VALIDATION_MESSAGE_KEYS[code]]).toEqual(expect.any(String))
    for (const check of VALIDATION_CHECKS) expect(dictionary[VALIDATION_CHECK_LABEL_KEYS[check]]).toEqual(expect.any(String))
  })

  describe('schema', () => {
    it('reports zod issues with their path and stops before the other checks', async () => {
      const report = await validate((input) => {
        input.features[0].label = ''
        input.rules = [rule('E', 'error', '{feature.ghost}')]
      })
      expect(report.ok).toBe(false)
      expect(report.issues).toEqual([
        { check: 'schema', code: 'schema_invalid', params: { path: 'features.0.label', reason: 'too_small' }, refs: [{ kind: 'path', path: 'features.0.label' }] },
      ])
    })

    it('rejects a non-object definition', async () => {
      const report = await validateForPublication({ definition: null, productId: PRODUCT_ID, catalog: fakeCatalog().port })
      expect(codesOf(report)).toEqual(['schema:schema_invalid'])
    })

    it('reports a negative static BOM quantity as bom_negative_quantity', async () => {
      const report = await validate((input) => (input.bom[0].quantity = -1))
      expect(report.issues).toEqual([
        { check: 'schema', code: 'bom_negative_quantity', params: { path: 'bom.0.quantity' }, refs: [{ kind: 'path', path: 'bom.0.quantity' }] },
      ])
      expect((await validate((input) => (input.bom[0].quantity = 0))).ok).toBe(true)
    })
  })

  describe('limits', () => {
    it('reports collection limits with the limit', async () => {
      const report = await validate((input) => {
        input.formulas = Array.from({ length: DEFINITION_LIMITS.formulas + 1 }, (_, index) => ({ key: `k${index}`, expr: { kind: 'const', value: 1 } }))
      })
      expect(report.issues).toEqual([
        { check: 'limits', code: 'limit_exceeded', params: { path: 'formulas', limit: DEFINITION_LIMITS.formulas }, refs: [{ kind: 'path', path: 'formulas' }] },
      ])
    })

    it('reports a definition above 512 KB', async () => {
      const report = await validate((input) => {
        input.fixedSpecification = [{ label: 'Notes', value: 'x'.repeat(DEFINITION_LIMITS.definitionBytes) }]
      })
      expect(codesOf(report)).toEqual(['limits:definition_too_large'])
    })

    it('accepts an expression at the depth limit and rejects one level deeper', async () => {
      expect((await validate((input) => (input.formulas[0].expr = nested(DEFINITION_LIMITS.expressionDepth)))).ok).toBe(true)
      const report = await validate((input) => (input.formulas[0].expr = nested(DEFINITION_LIMITS.expressionDepth + 1)))
      expect(report.issues).toEqual([
        {
          check: 'limits',
          code: 'expression_too_deep',
          params: { path: 'formulas.0.expr', limit: DEFINITION_LIMITS.expressionDepth },
          refs: [{ kind: 'path', path: 'formulas.0.expr' }],
        },
      ])
    })

    it('rejects very deep input without overflowing the stack', async () => {
      const report = await validate((input) => (input.formulas[0].expr = nested(50_000)))
      expect(codesOf(report)).toEqual(['limits:definition_too_deep'])
    })
  })

  describe('duplicate_key', () => {
    it('reports each duplicated feature, formula, lookup, BOM and rule key once', async () => {
      const report = await validate((input) => {
        input.features.push({ ...input.features[2], order: 9 }, { ...input.features[2], order: 10 })
        input.formulas.push({ ...input.formulas[0] })
        input.lookups.push({ ...input.lookups[1] })
        input.bom.push({ ...input.bom[0], order: 9 })
        input.rules = [rule('W', 'warning', ''), rule('W', 'warning', '', 2)]
      })
      expect(report.issues.filter((issue) => issue.check === 'duplicate_key').map((issue) => issue.params)).toEqual([
        { collection: 'features', key: 'cover' },
        { collection: 'formulas', key: 'pipe_meters' },
        { collection: 'lookups', key: 'motor_weight' },
        { collection: 'bom', key: 'base' },
        { collection: 'rules', key: 'W' },
      ])
    })
  })

  describe('referential_integrity', () => {
    it('reports unknown features, formulas and lookups named by conditions, actions and BOM lines', async () => {
      const report = await validate((input) => {
        input.features[5].visibleWhen = [{ kind: 'compare', featureKey: 'ghost', op: 'eq', value: 'x' }]
        input.rules = [
          {
            ...setRule('F', 1, { featureKey: 'motor', value: 'heavy' }, { featureKey: 'phantom', value: 'x' }),
            when: [{ kind: 'calculated', formulaKey: 'nope', op: 'gt', value: 1 }],
          },
        ]
        input.bom[2].quantity = { formulaKey: 'missing' }
        input.lookups.push({ kind: 'value', key: 'orphan', keyedBy: 'nobody', rows: [] })
        input.bom.push({ id: 'extra', skuFromLookup: { lookupKey: 'absent', keyedBy: 'motor' }, uom: 'pcs', quantity: 1, when: [], order: 9 })
      })
      expect(
        report.issues.filter((issue) => issue.check === 'referential_integrity').map((issue) => [issue.code, issue.params, issue.refs]),
      ).toEqual([
        ['unknown_feature', { featureKey: 'ghost', ownerKey: 'remote' }, [{ kind: 'feature', key: 'remote' }]],
        ['unknown_feature', { featureKey: 'nobody', ownerKey: 'orphan' }, [{ kind: 'lookup', key: 'orphan' }]],
        ['unknown_formula', { formulaKey: 'nope', ownerKey: 'F' }, [{ kind: 'rule', key: 'F' }]],
        ['unknown_feature', { featureKey: 'phantom', ownerKey: 'F' }, [{ kind: 'rule', key: 'F' }]],
        ['unknown_formula', { formulaKey: 'missing', ownerKey: 'pipe' }, [{ kind: 'bom', key: 'pipe' }]],
        ['unknown_lookup', { lookupKey: 'absent', ownerKey: 'extra' }, [{ kind: 'bom', key: 'extra' }]],
      ])
    })

    it('reports a lookup of the wrong kind', async () => {
      const report = await validate((input) => {
        input.features[4].optionsFromLookup = 'motor_weight'
        input.bom[1].skuFromLookup = { lookupKey: 'seals_by_motor', keyedBy: 'motor' }
      })
      const kindIssues = report.issues.filter((issue) => issue.code === 'lookup_kind_mismatch').map((issue) => issue.params)
      expect(kindIssues).toEqual([
        { lookupKey: 'motor_weight', expected: 'permitted', ownerKey: 'seal' },
        { lookupKey: 'seals_by_motor', expected: 'value', ownerKey: 'motor' },
      ])
    })

    it('reports lookup_keyed_by_mismatch when a reference keys a lookup by another feature', async () => {
      const report = await validate((input) => {
        input.bom[1].skuFromLookup = { lookupKey: 'motor_skus', keyedBy: 'color' }
        input.rules = [
          {
            ...rule('D', 'force', ''),
            when: [{ kind: 'not_in_lookup', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'color' }],
            action: { kind: 'lookup_default', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'cover' },
          },
        ]
      })
      expect(report.issues.filter((issue) => issue.code === 'lookup_keyed_by_mismatch').map((issue) => issue.params)).toEqual([
        { lookupKey: 'seals_by_motor', keyedBy: 'color', expected: 'motor', ownerKey: 'D' },
        { lookupKey: 'seals_by_motor', keyedBy: 'cover', expected: 'motor', ownerKey: 'D' },
        { lookupKey: 'motor_skus', keyedBy: 'color', expected: 'motor', ownerKey: 'motor' },
      ])
    })

    it('accepts a not_in_lookup and lookup_default keyed like the lookup', async () => {
      const report = await validate((input) => {
        input.rules = [
          {
            ...rule('D', 'force', ''),
            when: [{ kind: 'not_in_lookup', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' }],
            action: { kind: 'lookup_default', featureKey: 'seal', lookupKey: 'seals_by_motor', keyedBy: 'motor' },
          },
        ]
      })
      expect(report).toEqual({ ok: true, issues: [] })
    })
  })

  describe('lookup_coverage', () => {
    it('reports an option of the keyedBy feature without a row in an SKU lookup', async () => {
      const report = await validate((input) => {
        const skus = valueLookup(input, 'motor_skus')
        skus.rows = skus.rows.filter((row) => row.match !== 'heavy')
      })
      expect(report.issues).toEqual([
        {
          check: 'lookup_coverage',
          code: 'lookup_row_missing',
          params: { lookupKey: 'motor_skus', featureKey: 'motor', value: 'heavy' },
          refs: [{ kind: 'lookup', key: 'motor_skus' }, { kind: 'bom', key: 'motor' }],
        },
      ])
    })

    it('covers permitted lookups and boolean keys, and skips number keys', async () => {
      const report = await validate((input) => {
        input.lookups[0].keyedBy = 'cover'
        input.lookups[0].rows = [{ match: 'true', values: ['epdm'], default: 'epdm' }]
        input.lookups.push({ kind: 'value', key: 'pipe_skus', keyedBy: 'length', rows: [{ match: '2', value: 'PIPE-M' }] })
        input.bom[2] = { ...input.bom[2], sku: undefined, skuFromLookup: { lookupKey: 'pipe_skus', keyedBy: 'length' } }
      })
      expect(report.issues.filter((issue) => issue.check === 'lookup_coverage').map((issue) => issue.params)).toEqual([
        { lookupKey: 'seals_by_motor', featureKey: 'cover', value: 'false' },
      ])
    })

    it('reports a value lookup read by a formula or a placeholder without a row for an option', async () => {
      const report = await validate((input) => {
        const weights = valueLookup(input, 'motor_weight')
        weights.rows = weights.rows.filter((row) => row.match !== 'heavy')
        input.lookups.push({ kind: 'value', key: 'cover_note', keyedBy: 'cover', rows: [{ match: 'true', value: 'with cover' }] })
        input.rules = [rule('W', 'warning', 'Pump {lookup.cover_note}')]
      })
      expect(report.issues.filter((issue) => issue.check === 'lookup_coverage')).toEqual([
        {
          check: 'lookup_coverage',
          code: 'lookup_row_missing',
          params: { lookupKey: 'motor_weight', featureKey: 'motor', value: 'heavy' },
          refs: [{ kind: 'lookup', key: 'motor_weight' }, { kind: 'formula', key: 'weight' }],
        },
        {
          check: 'lookup_coverage',
          code: 'lookup_row_missing',
          params: { lookupKey: 'cover_note', featureKey: 'cover', value: 'false' },
          refs: [{ kind: 'lookup', key: 'cover_note' }, { kind: 'rule', key: 'W' }],
        },
      ])
    })

    it('accepts covered value lookups in formulas and placeholders, and skips number keys and permitted placeholders', async () => {
      const report = await validate((input) => {
        input.lookups.push(
          { kind: 'value', key: 'cover_note', keyedBy: 'cover', rows: [{ match: 'true', value: 'with cover' }, { match: 'false', value: 'open' }] },
          { kind: 'value', key: 'length_factor', keyedBy: 'length', rows: [{ match: '2', value: 1.5 }] },
          { kind: 'permitted', key: 'heavy_seals', keyedBy: 'motor', rows: [{ match: 'heavy', values: ['ptfe'], default: 'ptfe' }] },
        )
        input.formulas.push({ key: 'factor', expr: { kind: 'lookup', lookupKey: 'length_factor' } })
        input.rules = [rule('W', 'warning', '{lookup.motor_weight} {lookup.cover_note} {lookup.length_factor} {lookup.heavy_seals}')]
      })
      expect(report.issues.filter((issue) => issue.check === 'lookup_coverage')).toEqual([])
    })
  })

  describe('formula_cycle', () => {
    it('reports each group of formulas that read each other, including a self reference', async () => {
      const report = await validate((input) => {
        input.formulas.push(
          { key: 'a', expr: { kind: 'formula', formulaKey: 'b' } },
          { key: 'b', expr: { kind: 'op', op: '+', left: { kind: 'formula', formulaKey: 'a' }, right: { kind: 'const', value: 1 } } },
          { key: 'self', expr: { kind: 'formula', formulaKey: 'self' } },
          { key: 'reader', expr: { kind: 'formula', formulaKey: 'a' } },
        )
      })
      expect(report.issues.map((issue) => [issue.check, issue.params])).toEqual([
        ['formula_cycle', { formulaKeys: ['a', 'b'] }],
        ['formula_cycle', { formulaKeys: ['self'] }],
      ])
    })
  })

  describe('numeric_expr_reference', () => {
    it('accepts number features, numeric choice options and numeric value lookups', async () => {
      const report = await validate((input) => {
        input.features.push({ ...choiceFeature('boom', 7), options: [{ value: '8', label: '8 m', order: 1 }, { value: '12.5', label: '12.5 m', order: 2 }], default: '8' })
        input.formulas.push({ key: 'reach', expr: { kind: 'op', op: '*', left: { kind: 'feature', featureKey: 'boom' }, right: { kind: 'lookup', lookupKey: 'motor_weight' } } })
      })
      expect(report.ok).toBe(true)
    })

    it('reports non-numeric features and lookups and unknown references', async () => {
      const report = await validate((input) => {
        input.formulas.push(
          { key: 'flags', expr: { kind: 'op', op: '+', left: { kind: 'feature', featureKey: 'cover' }, right: { kind: 'feature', featureKey: 'motor' } } },
          { key: 'lists', expr: { kind: 'op', op: '+', left: { kind: 'lookup', lookupKey: 'seals_by_motor' }, right: { kind: 'lookup', lookupKey: 'motor_skus' } } },
          { key: 'ghosts', expr: { kind: 'op', op: '+', left: { kind: 'feature', featureKey: 'ghost' }, right: { kind: 'op', op: '+', left: { kind: 'lookup', lookupKey: 'nope' }, right: { kind: 'formula', formulaKey: 'missing' } } } },
        )
      })
      expect(report.issues.map((issue) => [issue.check, issue.code, issue.params])).toEqual([
        ['numeric_expr_reference', 'expr_feature_not_numeric', { featureKey: 'cover', formulaKey: 'flags' }],
        ['numeric_expr_reference', 'expr_feature_not_numeric', { featureKey: 'motor', formulaKey: 'flags' }],
        ['numeric_expr_reference', 'expr_lookup_not_numeric', { lookupKey: 'seals_by_motor', formulaKey: 'lists' }],
        ['numeric_expr_reference', 'expr_lookup_not_numeric', { lookupKey: 'motor_skus', formulaKey: 'lists' }],
        ['numeric_expr_reference', 'unknown_feature', { featureKey: 'ghost', ownerKey: 'ghosts' }],
        ['numeric_expr_reference', 'unknown_formula', { formulaKey: 'missing', ownerKey: 'ghosts' }],
        ['numeric_expr_reference', 'unknown_lookup', { lookupKey: 'nope', ownerKey: 'ghosts' }],
      ])
    })
  })

  describe('default_valid', () => {
    it('reports defaults outside options, bounds and step', async () => {
      const report = await validate((input) => {
        input.features[0].default = 'turbo'
        input.features[1].default = 25
        input.features.push({ ...input.features[1], key: 'width', default: 2.3, order: 9 })
      })
      expect(report.issues.map((issue) => [issue.check, issue.code, issue.params])).toEqual([
        ['default_valid', 'default_not_an_option', { featureKey: 'motor', value: 'turbo' }],
        ['default_valid', 'default_out_of_bounds', { featureKey: 'length', value: 25, min: 1, max: 20 }],
        ['default_valid', 'default_off_step', { featureKey: 'width', value: 2.3, step: 0.5 }],
      ])
    })
  })

  describe('action_value', () => {
    it('reports set and map values the target feature does not allow', async () => {
      const report = await validate((input) => {
        input.rules = [
          setRule('OUT', 1, { featureKey: 'motor', value: 'heavy' }, { featureKey: 'length', value: 25 }),
          setRule('STEP', 2, { featureKey: 'motor', value: 'heavy' }, { featureKey: 'length', value: 2.3 }),
          setRule('OK', 3, { featureKey: 'motor', value: 'heavy' }, { featureKey: 'length', value: '2.5' }),
          {
            id: 'MAP',
            effect: 'force',
            when: [],
            action: { kind: 'map', featureKey: 'motor', from: { standard: 'heavy', heavy: 'turbo' } },
            messageTemplate: '',
            featureKeys: [],
            order: 4,
          },
        ]
      })
      expect(report.issues.map((issue) => [issue.check, issue.code, issue.params, issue.refs])).toEqual([
        ['action_value', 'action_value_invalid', { ruleId: 'OUT', featureKey: 'length', value: 25 }, [{ kind: 'rule', key: 'OUT' }]],
        ['action_value', 'action_value_invalid', { ruleId: 'STEP', featureKey: 'length', value: 2.3 }, [{ kind: 'rule', key: 'STEP' }]],
        ['action_value', 'action_value_invalid', { ruleId: 'MAP', featureKey: 'motor', value: 'turbo' }, [{ kind: 'rule', key: 'MAP' }]],
      ])
    })
  })

  describe('surcharge_binding', () => {
    it('accepts a surcharge rule bound to one BOM line', async () => {
      const report = await validate((input) => {
        input.rules = [rule('S', 'surcharge', 'Extra pipe adds {line.pipe_extra.total}')]
        input.bom[3].ruleId = 'S'
      })
      expect(report.ok).toBe(true)
    })

    it('reports unknown rules, non-surcharge rules and a rule bound to several lines', async () => {
      const report = await validate((input) => {
        input.rules = [rule('S', 'surcharge', ''), rule('E', 'error', '', 2)]
        input.bom[0].ruleId = 'S'
        input.bom[1].ruleId = 'S'
        input.bom[2].ruleId = 'E'
        input.bom[3].ruleId = 'GONE'
      })
      expect(report.issues.map((issue) => [issue.check, issue.code, issue.params])).toEqual([
        ['surcharge_binding', 'surcharge_rule_expected', { ruleId: 'E', bomId: 'pipe', effect: 'error' }],
        ['surcharge_binding', 'unknown_rule', { ruleId: 'GONE', bomId: 'pipe_extra' }],
        ['surcharge_binding', 'surcharge_multiple_lines', { ruleId: 'S', bomIds: ['base', 'motor'] }],
      ])
    })
  })

  describe('placeholder_reference', () => {
    it('accepts known placeholders', async () => {
      const report = await validate((input) => {
        input.rules = [rule('W', 'warning', '{feature.motor} weighs {formula.weight} ({lookup.motor_weight}, {lookup.seals_by_motor})')]
      })
      expect(report.ok).toBe(true)
    })

    it('reports unknown keys, malformed tokens and line totals outside their surcharge rule', async () => {
      const report = await validate((input) => {
        input.rules = [
          rule('E', 'error', '{feature.ghost} {formula.nope} {lookup.none} {formula.} {line.base.total} {feature.motor'),
          rule('S', 'surcharge', '{line.pipe_extra.total} {line.ghost.total}', 2),
        ]
        input.bom[0].ruleId = 'S'
      })
      expect(report.issues.map((issue) => [issue.check, issue.code, issue.params])).toEqual([
        ['placeholder_reference', 'placeholder_malformed', { ruleId: 'E', token: '{formula.}' }],
        ['placeholder_reference', 'placeholder_malformed', { ruleId: 'E', token: '{feature.motor' }],
        ['placeholder_reference', 'unknown_feature', { ruleId: 'E', token: '{feature.ghost}', featureKey: 'ghost', ownerKey: 'E' }],
        ['placeholder_reference', 'unknown_formula', { ruleId: 'E', token: '{formula.nope}', formulaKey: 'nope', ownerKey: 'E' }],
        ['placeholder_reference', 'unknown_lookup', { ruleId: 'E', token: '{lookup.none}', lookupKey: 'none', ownerKey: 'E' }],
        ['placeholder_reference', 'placeholder_line_not_allowed', { ruleId: 'E', token: '{line.base.total}', bomId: 'base' }],
        ['placeholder_reference', 'placeholder_line_not_allowed', { ruleId: 'S', token: '{line.pipe_extra.total}', bomId: 'pipe_extra' }],
        ['placeholder_reference', 'unknown_bom_line', { ruleId: 'S', token: '{line.ghost.total}', bomId: 'ghost' }],
      ])
    })
  })
})
