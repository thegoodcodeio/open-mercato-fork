const apiCallMock = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCall: (...args: unknown[]) => apiCallMock(...args) }))

import { clearOrderSnapshotsCache, loadOrderConfiguredLinesShared, orderHref } from '../orderApi'
import { snapshotDocumentFromParams, snapshotHref, snapshotUrl } from '../../snapshots/snapshotsApi'
import type { SnapshotReadModel } from '../../snapshots/snapshotsApi'

const ORDER_ID = '55555555-5555-4555-8555-555555555555'
const S1 = '00000000-0000-4000-8000-000000000001'
const S2 = '00000000-0000-4000-8000-000000000002'

function snapshot(id: string, lineId: string | null): SnapshotReadModel {
  return {
    id,
    sessionId: `session-${id}`,
    quoteId: 'q',
    quoteLineId: lineId,
    lineState: 'present',
    lineId,
    lineName: 'Pump',
    modelTitle: 'Pump',
    modelVersion: { id: 'v', version: 1, hash: 'h' },
    summary: '',
    selectionRows: [],
    calculatedRows: [],
    specification: [],
    bom: [],
    netPrice: '100.00',
    currencyCode: 'EUR',
    warnings: [],
    hash: 'h',
    createdAt: '2026-11-06T10:00:00.000Z',
  }
}

beforeEach(() => {
  apiCallMock.mockReset()
  clearOrderSnapshotsCache()
})

describe('order configurations API', () => {
  it('links snapshots and reads them through the document they were opened from', () => {
    expect(orderHref(ORDER_ID)).toBe(`/backend/sales/orders/${ORDER_ID}`)
    expect(snapshotHref('s1', { kind: 'order', id: ORDER_ID })).toBe(`/backend/product_configurator/snapshots/s1?orderId=${ORDER_ID}`)
    expect(snapshotHref('s1', { kind: 'quote', id: 'q1' })).toBe('/backend/product_configurator/snapshots/s1?quoteId=q1')
    expect(snapshotUrl('s1', { kind: 'order', id: ORDER_ID })).toBe(`/api/product_configurator/snapshots?id=s1&orderId=${ORDER_ID}`)
    expect(snapshotUrl('s1', { kind: 'quote', id: 'q1' })).toBe('/api/product_configurator/snapshots?quoteId=q1&ids=s1')
    expect(snapshotUrl('s1', null)).toBe('/api/product_configurator/snapshots?id=s1')
    expect(snapshotDocumentFromParams(new URLSearchParams(`orderId=${ORDER_ID}`))).toEqual({ kind: 'order', id: ORDER_ID })
    expect(snapshotDocumentFromParams(new URLSearchParams('quoteId=q1'))).toEqual({ kind: 'quote', id: 'q1' })
    expect(snapshotDocumentFromParams(new URLSearchParams())).toBeNull()
  })

  it('maps the configured order lines by line id and shares one load between the cells of an order', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [snapshot('s1', 'line-1'), snapshot('s2', 'line-2')], truncated: false } })
    const [first, second] = await Promise.all([loadOrderConfiguredLinesShared(ORDER_ID, 0, 1000), loadOrderConfiguredLinesShared(ORDER_ID, 0, 1001)])
    expect(first).toBe(second)
    expect(first.get('line-2')?.id).toBe('s2')
    expect(first.get('line-3')).toBeUndefined()
    expect(apiCallMock).toHaveBeenCalledTimes(1)
    expect(apiCallMock.mock.calls[0][0]).toBe(`/api/product_configurator/snapshots?orderId=${ORDER_ID}`)
    await loadOrderConfiguredLinesShared(ORDER_ID, 0, 1000 + 31_000)
    expect(apiCallMock).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a load made for another organization selection', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [snapshot('s1', 'line-1')], truncated: false } })
    const before = await loadOrderConfiguredLinesShared(ORDER_ID, 0, 1000)
    const after = await loadOrderConfiguredLinesShared(ORDER_ID, 1, 1001)
    expect(after).not.toBe(before)
    expect(apiCallMock).toHaveBeenCalledTimes(2)
    expect(await loadOrderConfiguredLinesShared(ORDER_ID, 1, 1002)).toBe(after)
  })

  it('drops expired entries of other orders on read and does not keep a failure', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: { items: [] } })
    const stale = await loadOrderConfiguredLinesShared('other-order', 0, 1000)
    await loadOrderConfiguredLinesShared(ORDER_ID, 0, 1000 + 31_000)
    expect(await loadOrderConfiguredLinesShared('other-order', 0, 1000 + 31_001)).not.toBe(stale)

    clearOrderSnapshotsCache()
    apiCallMock.mockReset()
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 500, result: null })
    await expect(loadOrderConfiguredLinesShared(ORDER_ID, 0, 5000)).rejects.toThrow()
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: { items: [] } })
    await expect(loadOrderConfiguredLinesShared(ORDER_ID, 0, 5001)).resolves.toEqual(new Map())
  })

  it('completes a truncated list with the snapshots the order line markers reference, by id', async () => {
    const markedLines = [
      { id: 'line-1', configuration: { productConfigurator: { snapshotId: S1 } } },
      { id: 'line-2', configuration: JSON.stringify({ productConfigurator: { snapshotId: S2 } }) },
      { id: 'line-3', configuration: null },
      { id: 'line-4', configuration: { productConfigurator: { snapshotId: 'not-a-uuid' } } },
    ]
    apiCallMock.mockImplementation((url: string) => {
      if (url === `/api/product_configurator/snapshots?orderId=${ORDER_ID}`) {
        return Promise.resolve({ ok: true, status: 200, result: { items: [snapshot(S1, 'line-1')], truncated: true } })
      }
      if (url.startsWith('/api/sales/order-lines')) return Promise.resolve({ ok: true, status: 200, result: { items: markedLines } })
      return Promise.resolve({ ok: true, status: 200, result: { items: [snapshot(S2, 'line-2')], truncated: false } })
    })
    const byLine = await loadOrderConfiguredLinesShared(ORDER_ID, 0, 1000)
    expect(byLine.get('line-1')?.id).toBe(S1)
    expect(byLine.get('line-2')?.id).toBe(S2)
    expect(byLine.has('line-3')).toBe(false)
    const urls = apiCallMock.mock.calls.map(([url]) => url as string)
    expect(urls[1]).toBe(`/api/sales/order-lines?orderId=${ORDER_ID}&page=1&pageSize=100`)
    expect(urls[2]).toBe(`/api/product_configurator/snapshots?orderId=${ORDER_ID}&ids=${S2}`)
  })
})
