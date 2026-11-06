import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import { distinctUnits, type SkuUnitSummary } from './bomCatalog'

/** Why the catalog gives no single unit for a line, one message per problem (empty when the unit is clear or still checking). */
export function unitProblems(summary: SkuUnitSummary, lookupName: string | null, t: TranslateFn): string[] {
  const problems: string[] = []
  if (summary.unavailable) {
    problems.push(t('product_configurator.studio.bom.unit.unavailable', 'Could not read the catalog, so the unit cannot be checked now.'))
  }
  if (summary.unknown.length > 0) {
    problems.push(t('product_configurator.studio.bom.unit.unknown', 'Not in the catalog: {skus}', { skus: summary.unknown.join(', ') }))
  }
  if (summary.ambiguous.length > 0) {
    problems.push(
      t('product_configurator.studio.bom.unit.ambiguous', 'Found on both a product and a variant: {skus}', { skus: summary.ambiguous.join(', ') }),
    )
  }
  if (summary.missingUnit.length > 0) {
    problems.push(
      t('product_configurator.studio.bom.unit.missing', 'No base unit in the catalog: {skus}', { skus: summary.missingUnit.join(', ') }),
    )
  }
  const units = distinctUnits(summary)
  if (units.length > 1) {
    problems.push(
      t('product_configurator.studio.bom.unit.mixed', 'The SKUs in {lookup} use different units ({units}). Use SKUs sold in one unit.', {
        lookup: lookupName ?? '',
        units: units.join(', '),
      }),
    )
  }
  return problems
}

/** "BKT-150: pc, FORK-SET: set", shown under "no common unit". */
export function unitList(summary: SkuUnitSummary): string {
  return summary.units.map((entry) => `${entry.sku}: ${entry.unit}`).join(', ')
}
