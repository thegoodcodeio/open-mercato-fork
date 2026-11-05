import type { SelectionValue } from '../../data/validators'
import type { Selections } from '../values'

export type IssueParamValue = string | number | boolean | null | string[]
export type IssueParams = Record<string, IssueParamValue>

export type RuleIssue = { ruleId: string; params: IssueParams }

export type SystemIssueCode = 'option_not_available' | 'no_permitted_values' | 'bom_sku_unmapped' | 'bom_negative_quantity'
export type SystemIssue = { code: SystemIssueCode; params: IssueParams }

export type StructureError = RuleIssue | SystemIssue

export type SurchargeNotice = { ruleId: string; bomId: string; params: IssueParams }

export type ForcedChange = { featureKey: string; ruleId: string; from: SelectionValue; to: SelectionValue }

export type StructureBomLine = { bomId: string; sku: string; quantity: string; uom: string; ruleId?: string }

export type FeatureAvailability = { allowedValues: string[]; reason?: 'no_permitted_values' }

export type StructureResult = {
  modelVersionId: string
  modelVersionHash: string
  currencyCode: string
  priceKindId: string
  selections: Selections
  visibility: Record<string, boolean>
  forced: ForcedChange[]
  calculated: Record<string, number>
  bom: StructureBomLine[]
  availability: Record<string, FeatureAvailability>
  errors: StructureError[]
  warnings: RuleIssue[]
  surcharges: SurchargeNotice[]
  finalisable: boolean
}

export type PricedBomLine = StructureBomLine & { unitPrice: string; total: string }

export type SkuQuantity = { sku: string; quantity: string }

export type PriceResult = {
  currencyCode: string
  currencyExponent: number
  bom: PricedBomLine[]
  skuQuantities: SkuQuantity[]
  netPrice: string
  hash: string
}
