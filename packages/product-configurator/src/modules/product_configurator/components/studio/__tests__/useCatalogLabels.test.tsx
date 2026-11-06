/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from '@testing-library/react'

const apiCallMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (url: string) => apiCallMock(url),
}))

import { useCatalogLabels } from '../useCatalogLabels'

function titled(id: string, title: string) {
  return { ok: true, result: { items: [{ id, title }] } }
}

describe('useCatalogLabels', () => {
  beforeEach(() => {
    apiCallMock.mockReset()
    jest.restoreAllMocks()
  })

  it('shares one request per URL between mounts', async () => {
    apiCallMock.mockImplementation(async () => titled('product-shared', 'Pump'))
    const first = renderHook(() => useCatalogLabels('product-shared', null))
    const second = renderHook(() => useCatalogLabels('product-shared', null))
    await waitFor(() => expect(first.result.current.product).toBe('Pump'))
    await waitFor(() => expect(second.result.current.product).toBe('Pump'))
    expect(apiCallMock).toHaveBeenCalledTimes(1)
  })

  it('reads the price kind title from the product configurator price kinds route', async () => {
    const priceKindId = '2f1c7c1e-5b7a-4f0e-9a3d-0c6f1b2a3d4e'
    apiCallMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/product_configurator/price-kinds')
        ? { ok: true, result: { items: [{ id: priceKindId, code: 'regular', title: 'Regular', isActive: true }] } }
        : titled('product-price-kind', 'Pump'),
    )
    const { result } = renderHook(() => useCatalogLabels('product-price-kind', priceKindId))
    await waitFor(() => expect(result.current.priceKind).toBe('Regular'))
    expect(apiCallMock).toHaveBeenCalledWith(`/api/product_configurator/price-kinds?ids=${priceKindId}&pageSize=1`)
  })

  it('does not keep a failed read, so the next mount asks again', async () => {
    apiCallMock.mockImplementationOnce(async () => ({ ok: false, status: 500, result: null }))
    const failed = renderHook(() => useCatalogLabels('product-failing', null))
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(failed.result.current.product).toBeNull())
    failed.unmount()

    apiCallMock.mockImplementation(async () => titled('product-failing', 'Mixer'))
    const retried = renderHook(() => useCatalogLabels('product-failing', null))
    await waitFor(() => expect(retried.result.current.product).toBe('Mixer'))
    expect(apiCallMock).toHaveBeenCalledTimes(2)
  })

  it('reads the title again once the cached answer is older than a minute', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
    apiCallMock.mockImplementation(async () => titled('product-ttl', 'Old title'))
    const first = renderHook(() => useCatalogLabels('product-ttl', null))
    await waitFor(() => expect(first.result.current.product).toBe('Old title'))
    first.unmount()

    now.mockReturnValue(1_000_000 + 61_000)
    apiCallMock.mockImplementation(async () => titled('product-ttl', 'New title'))
    const second = renderHook(() => useCatalogLabels('product-ttl', null))
    await waitFor(() => expect(second.result.current.product).toBe('New title'))
    expect(apiCallMock).toHaveBeenCalledTimes(2)
  })
})
