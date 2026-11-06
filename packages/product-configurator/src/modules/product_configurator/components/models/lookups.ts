import {
  createIdsLookupSource,
  lookupLabelWithCode,
  pickLookupString,
  type LookupRemoteItem,
  type LookupSource,
} from '@open-mercato/ui/backend/inputs/lookupSources'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'

export { productLookupSource } from '@open-mercato/core/modules/catalog/components/lookupSources'

const CURRENCY_OPTIONS_URL = '/api/currencies/currencies/options'

// Publication rejects an inactive price kind, so the create dialog offers active ones only.
export const activePriceKindLookupSource: LookupSource = createIdsLookupSource(
  'product-configurator-price-kinds',
  '/api/product_configurator/price-kinds',
  (item) => {
    const value = pickLookupString(item, 'id')
    if (!value) return null
    return { value, label: lookupLabelWithCode(pickLookupString(item, 'title') || value, pickLookupString(item, 'code')) }
  },
  { isActive: 'true' },
)

export type CurrencyOption = { value: string; label: string }

/**
 * The currencies module or its `currencies.view` feature may be missing; the dialog then accepts a typed ISO code
 * and the filter offers no options, so a failed call yields an empty list instead of an error.
 */
export async function loadCurrencyOptions(query?: string): Promise<CurrencyOption[]> {
  const params = new URLSearchParams({ limit: '50' })
  const search = query?.trim()
  if (search) params.set('search', search)
  const call = await apiCall<{ items?: LookupRemoteItem[] }>(`${CURRENCY_OPTIONS_URL}?${params.toString()}`)
  if (!call.ok || !Array.isArray(call.result?.items)) return []
  const options: CurrencyOption[] = []
  for (const item of call.result.items) {
    if (!item || typeof item !== 'object') continue
    const code = pickLookupString(item, 'value')
    if (!code) continue
    const label = pickLookupString(item, 'label')
    options.push({ value: code, label: label && label !== code ? `${code} (${label})` : code })
  }
  return options
}
