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
const PRICE_KINDS_URL = '/api/product_configurator/price-kinds'

// Publication rejects an inactive price kind, so the create dialog offers active ones only.
export const activePriceKindLookupSource: LookupSource = createIdsLookupSource(
  'product-configurator-price-kinds',
  PRICE_KINDS_URL,
  (item) => {
    const value = pickLookupString(item, 'id')
    if (!value) return null
    const code = pickLookupString(item, 'code')
    const currencyCode = pickLookupString(item, 'currencyCode')
    return { value, label: lookupLabelWithCode(pickLookupString(item, 'title') || value, currencyCode ? `${code}, ${currencyCode}` : code) }
  },
  { isActive: 'true' },
)

/** The currency a price kind is bound to, or `null` when it has none or cannot be read. */
export async function loadPriceKindCurrency(priceKindId: string): Promise<string | null> {
  const call = await apiCall<{ items?: LookupRemoteItem[] }>(`${PRICE_KINDS_URL}?ids=${encodeURIComponent(priceKindId)}`)
  const item = call.ok && Array.isArray(call.result?.items) ? call.result.items[0] : undefined
  return item ? pickLookupString(item, 'currencyCode') || null : null
}

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
