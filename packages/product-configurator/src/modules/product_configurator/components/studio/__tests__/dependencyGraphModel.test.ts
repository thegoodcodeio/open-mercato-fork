import type { ConfigurationDefinitionInput } from '../../../data/validators'
import { PRICE_KIND_ID, choiceFeature, parseDefinition, setRule } from '../../../lib/__tests__/fixtures'
import type { ValidationIssue } from '../../../lib/validation/types'
import {
  DEPENDENCY_LAYER_GAP,
  DEPENDENCY_ROW_GAP,
  buildDependencyGraph,
  dependencyNodeId,
} from '../tabs/dependencies/dependencyGraphModel'

function definitionInput(): ConfigurationDefinitionInput {
  return {
    schemaVersion: 1,
    commercial: { currencyCode: 'EUR', priceKindId: PRICE_KIND_ID },
    fixedSpecification: [],
    features: [
      { key: 'length', label: 'Length', type: 'number', min: 1, max: 10, default: 2, order: 2, inSummary: true },
      { ...choiceFeature('motor', 1), label: 'Motor' },
      {
        key: 'cover',
        label: 'Cover',
        type: 'choice',
        optionsFromLookup: 'covers',
        default: 'x',
        order: 3,
        inSummary: false,
        visibleWhen: [{ kind: 'calculated', formulaKey: 'area', op: 'gt', value: 4 }],
      },
    ],
    lookups: [
      { kind: 'value', key: 'factor', label: 'Factor', keyedBy: 'motor', rows: [{ match: 'x', value: 2 }] },
      { kind: 'permitted', key: 'covers', keyedBy: 'motor', rows: [{ match: 'x', values: ['x'], default: 'x' }] },
      { kind: 'value', key: 'motor_sku', keyedBy: 'motor', rows: [{ match: 'x', value: 'M-X' }] },
    ],
    formulas: [
      {
        key: 'area',
        label: 'Area',
        expr: {
          kind: 'op',
          op: '*',
          left: { kind: 'feature', featureKey: 'length' },
          right: { kind: 'lookup', lookupKey: 'factor' },
        },
      },
      { key: 'pipe', expr: { kind: 'op', op: '+', left: { kind: 'formula', formulaKey: 'area' }, right: { kind: 'feature', featureKey: 'ghost' } } },
    ],
    rules: [
      { ...setRule('force-cover', 1, { featureKey: 'motor', value: 'y' }, { featureKey: 'cover', value: 'x' }), label: 'Force cover' },
      {
        id: 'paint',
        label: 'Paint surcharge',
        effect: 'surcharge',
        when: [{ kind: 'not_in_lookup', featureKey: 'cover', lookupKey: 'covers', keyedBy: 'motor' }],
        messageTemplate: 'Adds {line.paint_line.total} for {feature.length} m and {formula.pipe}',
        featureKeys: [],
        order: 2,
      },
    ],
    bom: [
      { id: 'base', sku: 'BASE', uom: 'pc', quantity: 1, when: [], order: 1 },
      {
        id: 'motor_line',
        skuFromLookup: { lookupKey: 'motor_sku', keyedBy: 'motor' },
        uom: 'pc',
        quantity: { formulaKey: 'pipe' },
        when: [{ kind: 'compare', featureKey: 'length', op: 'gt', value: 3 }],
        order: 2,
      },
      { id: 'paint_line', sku: 'PAINT', uom: 'pc', quantity: 1, when: [], ruleId: 'paint', order: 3 },
    ],
  }
}

const edgeKeys = (graph: ReturnType<typeof buildDependencyGraph>) =>
  graph.edges.map((edge) => `${edge.source} -${edge.kind}-> ${edge.target}`).sort((left, right) => left.localeCompare(right))

describe('buildDependencyGraph', () => {
  it('creates one node per feature, formula, lookup, rule and BOM line with friendly names and tabs', () => {
    const graph = buildDependencyGraph(parseDefinition(definitionInput()))
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    expect(graph.nodes).toHaveLength(13)
    expect(byId.get('feature:motor')).toMatchObject({ kind: 'feature', key: 'motor', name: 'Motor (motor)', tab: 'features' })
    expect(byId.get('formula:pipe')).toMatchObject({ name: 'pipe', tab: 'formulas' })
    expect(byId.get('lookup:factor')).toMatchObject({ name: 'Factor (factor)', tab: 'lookups' })
    expect(byId.get('rule:force-cover')).toMatchObject({ name: 'Force cover (force-cover)', tab: 'rules' })
    expect(byId.get('bom:base')).toMatchObject({ name: 'BASE (base)', tab: 'bom' })
    expect(byId.get('bom:motor_line')).toMatchObject({ name: 'motor_line', tab: 'bom' })
  })

  it('draws reads, rule writes and the surcharge binding, and drops references to unknown keys', () => {
    const graph = buildDependencyGraph(parseDefinition(definitionInput()))
    expect(edgeKeys(graph)).toEqual(
      [
        'bom:paint_line -surcharge-> rule:paint',
        'feature:length -reads-> bom:motor_line',
        'feature:length -reads-> formula:area',
        'feature:length -reads-> rule:paint',
        'feature:motor -reads-> bom:motor_line',
        'feature:motor -reads-> lookup:covers',
        'feature:motor -reads-> lookup:factor',
        'feature:motor -reads-> lookup:motor_sku',
        'feature:motor -reads-> rule:force-cover',
        'feature:cover -reads-> rule:paint',
        'feature:motor -reads-> rule:paint',
        'formula:area -reads-> feature:cover',
        'formula:area -reads-> formula:pipe',
        'formula:pipe -reads-> bom:motor_line',
        'formula:pipe -reads-> rule:paint',
        'lookup:covers -reads-> feature:cover',
        'lookup:covers -reads-> rule:paint',
        'lookup:factor -reads-> formula:area',
        'lookup:motor_sku -reads-> bom:motor_line',
        'rule:force-cover -writes-> feature:cover',
      ].sort((left, right) => left.localeCompare(right)),
    )
    expect(graph.edges.some((edge) => edge.source.includes('ghost'))).toBe(false)
  })

  it('lays nodes out in layers by dependency depth, in a stable order', () => {
    const definition = parseDefinition(definitionInput())
    const graph = buildDependencyGraph(definition)
    const depthOf = (id: string) => graph.nodes.find((node) => node.id === id)?.depth
    expect(depthOf('feature:motor')).toBe(0)
    expect(depthOf('feature:length')).toBe(0)
    expect(depthOf('lookup:factor')).toBe(1)
    expect(depthOf('formula:area')).toBe(2)
    expect(depthOf('formula:pipe')).toBe(3)
    expect(depthOf('feature:cover')).toBe(3)
    expect(depthOf('rule:paint')).toBe(4)
    expect(depthOf('bom:motor_line')).toBe(4)

    const motor = graph.nodes.find((node) => node.id === 'feature:motor')
    const length = graph.nodes.find((node) => node.id === 'feature:length')
    expect(motor?.position).toEqual({ x: 0, y: 0 })
    expect(length?.position).toEqual({ x: 0, y: DEPENDENCY_ROW_GAP })
    expect(graph.nodes.find((node) => node.id === 'formula:area')?.position.x).toBe(2 * DEPENDENCY_LAYER_GAP)
    expect(buildDependencyGraph(definition)).toEqual(graph)
  })

  it('gives every node of a loop a finite depth', () => {
    const input = definitionInput()
    input.features = [choiceFeature('a', 1), choiceFeature('b', 2)]
    input.lookups = []
    input.formulas = []
    input.bom = []
    input.rules = [setRule('a-to-b', 1, { featureKey: 'a', value: 'y' }, { featureKey: 'b', value: 'y' }), setRule('b-to-a', 2, { featureKey: 'b', value: 'x' }, { featureKey: 'a', value: 'x' })]
    const graph = buildDependencyGraph(parseDefinition(input))
    expect(graph.nodes.map((node) => Number.isFinite(node.depth))).toEqual([true, true, true, true])
  })

  it('highlights the nodes and edges named by formula_cycle and fixed_point issues', () => {
    const input = definitionInput()
    input.formulas.push({ key: 'loop_a', expr: { kind: 'formula', formulaKey: 'loop_b' } }, { key: 'loop_b', expr: { kind: 'formula', formulaKey: 'loop_a' } })
    const issues: ValidationIssue[] = [
      {
        check: 'formula_cycle',
        code: 'formula_cycle',
        params: { formulaKeys: ['loop_a', 'loop_b'] },
        refs: [{ kind: 'formula', key: 'loop_a' }, { kind: 'formula', key: 'loop_b' }],
      },
      {
        check: 'fixed_point',
        code: 'fixed_point_not_reached',
        params: { ruleIds: ['force-cover'], featureKeys: ['cover'] },
        refs: [{ kind: 'rule', key: 'force-cover' }, { kind: 'feature', key: 'cover' }],
      },
      { check: 'duplicate_key', code: 'duplicate_key', params: { key: 'motor' }, refs: [{ kind: 'feature', key: 'motor' }] },
    ]
    const graph = buildDependencyGraph(parseDefinition(input), issues)
    expect(graph.cycleIssues.map((issue) => issue.check)).toEqual(['formula_cycle', 'fixed_point'])
    expect(graph.nodes.filter((node) => node.inCycle).map((node) => node.id).sort((left, right) => left.localeCompare(right))).toEqual([
      'feature:cover',
      'formula:loop_a',
      'formula:loop_b',
      'rule:force-cover',
    ])
    expect(edgeKeys({ ...graph, edges: graph.edges.filter((edge) => edge.inCycle) })).toEqual([
      'formula:loop_a -reads-> formula:loop_b',
      'formula:loop_b -reads-> formula:loop_a',
      'rule:force-cover -writes-> feature:cover',
    ])
  })

  it('finds formula loops in the current draft and ignores formula loops of an older report', () => {
    const input = definitionInput()
    input.formulas.push({ key: 'loop_a', expr: { kind: 'formula', formulaKey: 'loop_b' } }, { key: 'loop_b', expr: { kind: 'formula', formulaKey: 'loop_a' } })
    const stale: ValidationIssue = {
      check: 'formula_cycle',
      code: 'formula_cycle',
      params: { formulaKeys: ['pipe_meters'] },
      refs: [{ kind: 'formula', key: 'pipe_meters' }],
    }
    const graph = buildDependencyGraph(parseDefinition(input), [stale])
    expect(graph.cycleIssues).toEqual([
      {
        check: 'formula_cycle',
        code: 'formula_cycle',
        params: { formulaKeys: ['loop_a', 'loop_b'] },
        refs: [{ kind: 'formula', key: 'loop_a' }, { kind: 'formula', key: 'loop_b' }],
      },
    ])
    expect(graph.nodes.filter((node) => node.inCycle).map((node) => node.id).sort((left, right) => left.localeCompare(right))).toEqual(['formula:loop_a', 'formula:loop_b'])
  })

  it('keeps the first row of a duplicate key', () => {
    const input = definitionInput()
    input.lookups.push({ kind: 'value', key: 'factor', label: 'Second factor', keyedBy: 'length', rows: [] })
    const graph = buildDependencyGraph(parseDefinition(input))
    expect(graph.nodes.filter((node) => node.id === dependencyNodeId('lookup', 'factor')).map((node) => node.name)).toEqual(['Factor (factor)'])
  })
})
