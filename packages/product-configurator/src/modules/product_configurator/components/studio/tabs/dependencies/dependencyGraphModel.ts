import type { Condition } from '../../../../data/validators'
import { extractPlaceholders } from '../../../../lib/messages'
import { expressionReads } from '../../../../lib/validation/formulas'
import type { ValidationIssue } from '../../../../lib/validation/types'
import { sortByOrder } from '../../../../lib/values'
import { friendlyName } from '../../names'
import type { StudioDefinition, StudioTabId } from '../types'

export type DependencyNodeKind = 'feature' | 'formula' | 'lookup' | 'rule' | 'bom'

/** `reads`: the target uses the source; `writes`: a force rule sets the target feature; `surcharge`: a BOM line bound to its surcharge rule. */
export type DependencyEdgeKind = 'reads' | 'writes' | 'surcharge'

export type DependencyNode = {
  id: string
  kind: DependencyNodeKind
  key: string
  name: string
  tab: StudioTabId
  depth: number
  position: { x: number; y: number }
  inCycle: boolean
}

export type DependencyEdge = {
  id: string
  source: string
  target: string
  kind: DependencyEdgeKind
  inCycle: boolean
}

export type DependencyGraphModel = {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
  /** Issues of the last report (`formula_cycle`, `fixed_point`) that are drawn on the graph. */
  cycleIssues: ValidationIssue[]
}

export const DEPENDENCY_LAYER_GAP = 300
export const DEPENDENCY_ROW_GAP = 88

const KIND_TABS: Record<DependencyNodeKind, StudioTabId> = {
  feature: 'features',
  formula: 'formulas',
  lookup: 'lookups',
  rule: 'rules',
  bom: 'bom',
}

const CYCLE_CHECKS = new Set<ValidationIssue['check']>(['formula_cycle', 'fixed_point'])

export function dependencyNodeId(kind: DependencyNodeKind, key: string): string {
  return `${kind}:${key}`
}

function conditionReads(condition: Condition): string[] {
  switch (condition.kind) {
    case 'calculated':
      return [dependencyNodeId('formula', condition.formulaKey)]
    case 'not_in_lookup':
      return [
        dependencyNodeId('feature', condition.featureKey),
        dependencyNodeId('lookup', condition.lookupKey),
        dependencyNodeId('feature', condition.keyedBy),
      ]
    default:
      return [dependencyNodeId('feature', condition.featureKey)]
  }
}

function conditionsReads(conditions: readonly Condition[] | undefined): string[] {
  return (conditions ?? []).flatMap(conditionReads)
}

function messageReads(template: string): string[] {
  return extractPlaceholders(template).flatMap((placeholder) =>
    placeholder.kind === 'line' ? [] : [dependencyNodeId(placeholder.kind, placeholder.key)],
  )
}

/** Each `formula_cycle` / `fixed_point` issue as the set of node ids it names. */
function cycleGroups(issues: readonly ValidationIssue[]): Set<string>[] {
  return issues.map((issue) => {
    const group = new Set<string>()
    for (const ref of issue.refs) {
      if (ref.kind === 'feature' || ref.kind === 'formula' || ref.kind === 'rule') group.add(dependencyNodeId(ref.kind, ref.key))
    }
    return group
  })
}

/**
 * Depth = longest chain of reads leading to the node. An edge back to a node still being resolved
 * (a loop) is skipped, so loops get a stable depth that depends only on the definition order.
 */
function resolveDepths(nodeIds: readonly string[], edges: readonly DependencyEdge[]): Map<string, number> {
  const incoming = new Map<string, string[]>()
  for (const edge of edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
  const depths = new Map<string, number>()
  const resolving = new Set<string>()
  const resolve = (id: string): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    resolving.add(id)
    let depth = 0
    for (const source of incoming.get(id) ?? []) {
      if (!resolving.has(source)) depth = Math.max(depth, resolve(source) + 1)
    }
    resolving.delete(id)
    depths.set(id, depth)
    return depth
  }
  nodeIds.forEach(resolve)
  return depths
}

/**
 * Nodes and edges of the draft for the Dependencies tab, laid out in layers by dependency depth.
 * References to keys that do not exist are left out (Validate reports them); a duplicate key keeps its first row.
 */
export function buildDependencyGraph(definition: StudioDefinition, issues: readonly ValidationIssue[] = []): DependencyGraphModel {
  const nodes = new Map<string, Omit<DependencyNode, 'depth' | 'position' | 'inCycle'>>()
  const addNode = (kind: DependencyNodeKind, key: string, name: string) => {
    const id = dependencyNodeId(kind, key)
    if (!nodes.has(id)) nodes.set(id, { id, kind, key, name, tab: KIND_TABS[kind] })
  }
  for (const feature of sortByOrder(definition.features)) addNode('feature', feature.key, friendlyName(feature.label, feature.key))
  for (const lookup of definition.lookups) addNode('lookup', lookup.key, friendlyName(lookup.label, lookup.key))
  for (const formula of definition.formulas) addNode('formula', formula.key, friendlyName(formula.label, formula.key))
  for (const rule of sortByOrder(definition.rules)) addNode('rule', rule.id, friendlyName(rule.label, rule.id))
  for (const line of sortByOrder(definition.bom)) addNode('bom', line.id, friendlyName(line.sku, line.id))

  const edges = new Map<string, Omit<DependencyEdge, 'inCycle'>>()
  const addEdge = (source: string, target: string, kind: DependencyEdgeKind) => {
    const id = `${kind}:${source}->${target}`
    if (nodes.has(source) && nodes.has(target) && !edges.has(id)) edges.set(id, { id, source, target, kind })
  }
  const addReads = (target: string, sources: readonly string[]) => sources.forEach((source) => addEdge(source, target, 'reads'))

  for (const feature of definition.features) {
    const target = dependencyNodeId('feature', feature.key)
    addReads(target, conditionsReads(feature.visibleWhen))
    if (feature.optionsFromLookup) addReads(target, [dependencyNodeId('lookup', feature.optionsFromLookup)])
  }
  for (const lookup of definition.lookups) {
    addReads(dependencyNodeId('lookup', lookup.key), [dependencyNodeId('feature', lookup.keyedBy)])
  }
  for (const formula of definition.formulas) {
    const reads = expressionReads(formula.expr)
    addReads(dependencyNodeId('formula', formula.key), [
      ...[...reads.features].map((key) => dependencyNodeId('feature', key)),
      ...[...reads.lookups].map((key) => dependencyNodeId('lookup', key)),
      ...[...reads.formulas].map((key) => dependencyNodeId('formula', key)),
    ])
  }
  for (const rule of definition.rules) {
    const target = dependencyNodeId('rule', rule.id)
    addReads(target, [...conditionsReads(rule.when), ...messageReads(rule.messageTemplate)])
    if (!rule.action) continue
    if (rule.action.kind === 'lookup_default') {
      addReads(target, [dependencyNodeId('lookup', rule.action.lookupKey), dependencyNodeId('feature', rule.action.keyedBy)])
    }
    addEdge(target, dependencyNodeId('feature', rule.action.featureKey), 'writes')
  }
  for (const line of definition.bom) {
    const target = dependencyNodeId('bom', line.id)
    addReads(target, conditionsReads(line.when))
    if (line.skuFromLookup) {
      addReads(target, [dependencyNodeId('lookup', line.skuFromLookup.lookupKey), dependencyNodeId('feature', line.skuFromLookup.keyedBy)])
    }
    if (typeof line.quantity !== 'number') addReads(target, [dependencyNodeId('formula', line.quantity.formulaKey)])
    if (line.ruleId) addEdge(target, dependencyNodeId('rule', line.ruleId), 'surcharge')
  }

  const cycleIssues = issues.filter((issue) => CYCLE_CHECKS.has(issue.check))
  const groups = cycleGroups(cycleIssues)
  const inCycle = (id: string) => groups.some((group) => group.has(id))
  const edgeList = [...edges.values()].map((edge) => ({
    ...edge,
    inCycle: groups.some((group) => group.has(edge.source) && group.has(edge.target)),
  }))

  const nodeIds = [...nodes.keys()]
  const depths = resolveDepths(nodeIds, edgeList)
  const rowsByDepth = new Map<number, number>()
  const layered = [...nodes.values()]
    .map((node, index) => ({ node, index, depth: depths.get(node.id) ?? 0 }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
  const nodeList = layered.map(({ node, depth }) => {
    const row = rowsByDepth.get(depth) ?? 0
    rowsByDepth.set(depth, row + 1)
    return { ...node, depth, position: { x: depth * DEPENDENCY_LAYER_GAP, y: row * DEPENDENCY_ROW_GAP }, inCycle: inCycle(node.id) }
  })

  return { nodes: nodeList, edges: edgeList, cycleIssues }
}
