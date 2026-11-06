import type {
  BomLineDefinition,
  Condition,
  ConfigurationDefinition,
  Feature,
  Rule,
} from '../data/validators'

function mapList<T>(list: T[], map: (item: T) => T): T[] {
  const mapped = list.map(map)
  return mapped.every((item, index) => item === list[index]) ? list : mapped
}

/**
 * Points the redundant `keyedBy` of every consumer of lookup `lookupKey` (not_in_lookup conditions,
 * lookup_default actions, BOM skuFromLookup) at `keyedBy`. The lookup declaration itself is left alone.
 * Pure; unchanged branches keep their identity and `definition` is returned when nothing changes.
 */
export function syncLookupKeyedBy(
  definition: ConfigurationDefinition,
  lookupKey: string,
  keyedBy: string,
): ConfigurationDefinition {
  const syncCondition = (condition: Condition): Condition =>
    condition.kind === 'not_in_lookup' && condition.lookupKey === lookupKey && condition.keyedBy !== keyedBy
      ? { ...condition, keyedBy }
      : condition
  const syncConditions = (conditions: Condition[]) => mapList(conditions, syncCondition)

  const syncFeature = (feature: Feature): Feature => {
    if (feature.visibleWhen === undefined) return feature
    const visibleWhen = syncConditions(feature.visibleWhen)
    return visibleWhen === feature.visibleWhen ? feature : { ...feature, visibleWhen }
  }

  const syncRule = (rule: Rule): Rule => {
    const when = syncConditions(rule.when)
    const { action } = rule
    const synced = when === rule.when ? rule : { ...rule, when }
    if (action?.kind !== 'lookup_default' || action.lookupKey !== lookupKey || action.keyedBy === keyedBy) return synced
    return { ...synced, action: { ...action, keyedBy } }
  }

  const syncBomLine = (line: BomLineDefinition): BomLineDefinition => {
    const when = syncConditions(line.when)
    const { skuFromLookup } = line
    const synced = when === line.when ? line : { ...line, when }
    if (skuFromLookup?.lookupKey !== lookupKey || skuFromLookup.keyedBy === keyedBy) return synced
    return { ...synced, skuFromLookup: { ...skuFromLookup, keyedBy } }
  }

  const features = mapList(definition.features, syncFeature)
  const rules = mapList(definition.rules, syncRule)
  const bom = mapList(definition.bom, syncBomLine)
  if (features === definition.features && rules === definition.rules && bom === definition.bom) return definition
  return { ...definition, features, rules, bom }
}
