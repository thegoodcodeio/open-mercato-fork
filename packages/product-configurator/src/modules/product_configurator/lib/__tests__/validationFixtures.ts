import type { CatalogItemRef, PriceKindRef } from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import type { ConfigurationDefinitionInput } from '../../data/validators'
import { validateForPublication, type PublicationCatalogPort, type ValidationReport } from '../validation'
import { PRICE_KIND_ID, referenceInput } from './fixtures'

export const PRODUCT_ID = '3d0c7a52-1f4b-4e8a-9c2d-5b6e7f8a9b0c'

const REFERENCE_UNITS: Record<string, string> = {
  'PUMP-BASE': 'pcs',
  'MOTOR-STD': 'pcs',
  'MOTOR-HD': 'pcs',
  'PIPE-M': 'm',
}

export function catalogItem(sku: string, unit: string | null, salesUnitQuantity = '1'): CatalogItemRef {
  return { sku, productId: `product-${sku}`, variantId: null, title: sku, unit, salesUnitQuantity }
}

export type FakeCatalogOptions = {
  items?: Record<string, CatalogItemRef | null>
  ambiguous?: string[]
  productMissing?: boolean
  priceKindMissing?: boolean
}

export function fakeCatalog(options: FakeCatalogOptions = {}) {
  const items = new Map<string, CatalogItemRef>()
  for (const [sku, unit] of Object.entries(REFERENCE_UNITS)) items.set(sku, catalogItem(sku, unit))
  for (const [sku, item] of Object.entries(options.items ?? {})) {
    if (item) items.set(sku, item)
    else items.delete(sku)
  }
  const ambiguous = new Set(options.ambiguous ?? [])
  const priceKind: PriceKindRef = { id: PRICE_KIND_ID, code: 'regular', currencyCode: 'EUR', isPromotion: false }

  const resolveSkus = jest.fn(async (skus: string[]) => ({
    items: new Map(
      skus.flatMap((sku) => {
        const item = items.get(sku)
        return item && !ambiguous.has(sku) ? [[sku, item] as const] : []
      }),
    ),
    ambiguous: skus.filter((sku) => ambiguous.has(sku)),
  }))
  const port: PublicationCatalogPort = {
    resolveProducts: async (ids) =>
      new Map(
        options.productMissing ? [] : ids.map((id) => [id, { productId: id, sku: 'PUMP', title: 'Pump', taxRateId: null }]),
      ),
    resolveSkus,
    resolvePriceKinds: async (ids) => new Map(options.priceKindMissing ? [] : ids.filter((id) => id === priceKind.id).map((id) => [id, priceKind])),
  }
  return { port, resolveSkus }
}

export async function validate(
  mutate?: (input: ConfigurationDefinitionInput) => void,
  options?: FakeCatalogOptions,
): Promise<ValidationReport> {
  const input = referenceInput()
  mutate?.(input)
  return validateForPublication({ definition: input, productId: PRODUCT_ID, catalog: fakeCatalog(options).port })
}

export function codesOf(report: ValidationReport): string[] {
  return report.issues.map((issue) => `${issue.check}:${issue.code}`)
}
