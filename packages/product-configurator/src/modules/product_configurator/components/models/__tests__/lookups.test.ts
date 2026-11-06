const readApiResultOrThrowMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(),
  readApiResultOrThrow: (...args: unknown[]) => readApiResultOrThrowMock(...args),
}))

jest.mock('@open-mercato/core/modules/catalog/components/lookupSources', () => ({ productLookupSource: {} }))

import { activePriceKindLookupSource } from '../lookups'

describe('activePriceKindLookupSource', () => {
  beforeEach(() => readApiResultOrThrowMock.mockReset())

  it('searches active kinds through the product configurator route, not the catalog settings route', async () => {
    readApiResultOrThrowMock.mockResolvedValue({ items: [{ id: 'pk-1', code: 'regular', title: 'Regular price' }] })

    await expect(activePriceKindLookupSource.search('sale')).resolves.toEqual([{ value: 'pk-1', label: 'Regular price (regular)' }])

    const url = new URL(String(readApiResultOrThrowMock.mock.calls[0][0]), 'http://localhost')
    expect(url.pathname).toBe('/api/product_configurator/price-kinds')
    expect(Object.fromEntries(url.searchParams)).toEqual({ isActive: 'true', search: 'sale', pageSize: '50' })
  })
})
