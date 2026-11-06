import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { Cleanup } from './helpers/sessions'
import { configuredLines, convertQuote, createConfiguredSession, documentLines, finalise, finaliseOk, lineConfiguration, lineField } from './helpers/finalise'

// The race of a conversion with a concurrent line insert is pinned against a real database in
// lib/__tests__/finaliseStore.integration.test.ts; here the two orders are run one after the other.
test.describe('TC-PCFG-062: conversion and finalise', () => {
  test('convert, then finalise: quote_converted and no line on the order', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '062A')
      const orderId = await convertQuote(request, token, cleanup, fixture.quoteId)

      const response = await finalise(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      expect(response.status()).toBe(409)
      expect((await readJsonSafe<{ code: string }>(response))?.code).toBe('quote_converted')
      expect(configuredLines(await documentLines(request, token, 'order', orderId))).toEqual([])
    } finally {
      await cleanup.run()
    }
  })

  test('finalise, then convert: the order carries the configured line with its configuration', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '062B')
      const result = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })
      const orderId = await convertQuote(request, token, cleanup, fixture.quoteId)

      const lines = configuredLines(await documentLines(request, token, 'order', orderId))
      expect(lines.map((line) => line.id)).toEqual([result.quoteLineId])
      expect(lineConfiguration(lines[0])).toMatchObject({ productConfigurator: { snapshotId: result.snapshotId, hash: result.hash } })
      expect(Number(lineField(lines[0], 'unitPriceNet'))).toBe(100)
    } finally {
      await cleanup.run()
    }
  })
})
