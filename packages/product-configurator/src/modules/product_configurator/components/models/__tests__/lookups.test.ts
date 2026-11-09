const readApiResultOrThrowMock = jest.fn()
const apiCallMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
  readApiResultOrThrow: (...args: unknown[]) => readApiResultOrThrowMock(...args),
}))

jest.mock('@open-mercato/core/modules/catalog/components/lookupSources', () => ({ productLookupSource: {} }))

import { activePriceKindLookupSource, loadCurrencyOptions, loadPriceKindCurrency } from '../lookups'

describe('activePriceKindLookupSource', () => {
  beforeEach(() => readApiResultOrThrowMock.mockReset())

  it('searches active kinds through the product configurator route, not the catalog settings route', async () => {
    readApiResultOrThrowMock.mockResolvedValue({ items: [{ id: 'pk-1', code: 'regular', title: 'Regular price' }] })

    await expect(activePriceKindLookupSource.search('sale')).resolves.toEqual([{ value: 'pk-1', label: 'Regular price (regular)' }])

    const url = new URL(String(readApiResultOrThrowMock.mock.calls[0][0]), 'http://localhost')
    expect(url.pathname).toBe('/api/product_configurator/price-kinds')
    expect(Object.fromEntries(url.searchParams)).toEqual({ isActive: 'true', search: 'sale', pageSize: '50' })
  })

  it('shows the currency of a price kind next to its code', async () => {
    readApiResultOrThrowMock.mockResolvedValue({ items: [{ id: 'pk-2', code: 'usd_list', title: 'USD list', currencyCode: 'USD' }] })
    await expect(activePriceKindLookupSource.search('usd')).resolves.toEqual([{ value: 'pk-2', label: 'USD list (usd_list, USD)' }])
  })
})

describe('loadPriceKindCurrency', () => {
  beforeEach(() => apiCallMock.mockReset())

  it('reads the currency of one price kind and treats a missing one as none', async () => {
    apiCallMock.mockResolvedValue({ ok: true, result: { items: [{ id: 'pk-2', currencyCode: 'USD' }] } })
    await expect(loadPriceKindCurrency('pk-2')).resolves.toBe('USD')
    expect(apiCallMock).toHaveBeenCalledWith('/api/product_configurator/price-kinds?ids=pk-2')

    apiCallMock.mockResolvedValue({ ok: true, result: { items: [{ id: 'pk-3', currencyCode: null }] } })
    await expect(loadPriceKindCurrency('pk-3')).resolves.toBeNull()
    apiCallMock.mockResolvedValue({ ok: false, result: null })
    await expect(loadPriceKindCurrency('pk-4')).resolves.toBeNull()
  })
})

describe('loadCurrencyOptions', () => {
  beforeEach(() => apiCallMock.mockReset())

  it('maps currency options and yields none when the call fails or is forbidden', async () => {
    apiCallMock.mockResolvedValue({ ok: true, result: { items: [{ value: 'EUR', label: 'Euro' }, { value: 'USD', label: 'USD' }] } })
    await expect(loadCurrencyOptions(' eu ')).resolves.toEqual([
      { value: 'EUR', label: 'EUR (Euro)' },
      { value: 'USD', label: 'USD' },
    ])
    expect(apiCallMock).toHaveBeenCalledWith('/api/currencies/currencies/options?limit=50&search=eu', {
      headers: { 'x-om-forbidden-redirect': '0' },
    })

    apiCallMock.mockResolvedValue({ ok: false, status: 500, result: null })
    await expect(loadCurrencyOptions()).resolves.toEqual([])

    apiCallMock.mockResolvedValue({ ok: false, status: 403, result: { error: 'Forbidden', requiredFeatures: ['currencies.view'] } })
    await expect(loadCurrencyOptions()).resolves.toEqual([])

    const failure = new Error('network down')
    apiCallMock.mockRejectedValue(failure)
    await expect(loadCurrencyOptions()).rejects.toBe(failure)
  })
})
