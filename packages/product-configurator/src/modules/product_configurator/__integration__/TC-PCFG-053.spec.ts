import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { publishModel, readModel, saveModel } from './helpers/fixtures'
import { Cleanup, readSession } from './helpers/sessions'
import { configuredLines, createConfiguredSession, documentLines, finalise, finaliseOk } from './helpers/finalise'
import { evaluateStoredSelections, openCopy } from './helpers/copies'

type Feature = { key: string; options?: Array<{ value: string }> }

test.describe('TC-PCFG-053: "Add another identical" across model versions', () => {
  test('open returns the migration, the copy starts without the removed choice, and finalise needs migrationAcknowledged', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const cleanup = new Cleanup()
    try {
      const fixture = await createConfiguredSession(request, token, cleanup, '053')
      const source = await finaliseOk(request, token, { id: fixture.sessionId, expectedHash: fixture.evaluation.hash, revision: fixture.revision })

      const draft = await readModel(request, token, fixture.modelId)
      const features = (draft.draftDefinition.features as Feature[]).map((feature) =>
        feature.key === 'size' ? { ...feature, options: feature.options?.filter((option) => option.value !== 'l') } : feature,
      )
      const saved = await saveModel(request, token, { id: fixture.modelId, updatedAt: draft.updatedAt, draftDefinition: { ...draft.draftDefinition, features } })
      expect(saved.status(), await saved.text()).toBe(200)
      const savedBody = await readJsonSafe<{ updatedAt: string }>(saved)
      const published = await publishModel(request, token, fixture.modelId, savedBody?.updatedAt)
      expect(published.status(), await published.text()).toBe(200)
      const v2 = await readJsonSafe<{ modelVersionId: string; version: number }>(published)
      expect(v2?.version).toBe(2)

      const copy = await openCopy(request, token, cleanup, { quoteId: fixture.quoteId, fromSnapshotId: source.snapshotId })
      expect(copy).toMatchObject({ mode: 'duplicate', sourceSnapshotId: source.snapshotId, modelVersion: { id: v2?.modelVersionId, version: 2 } })
      expect(copy.migration).toEqual({
        fromVersion: { id: expect.any(String), version: 1 },
        toVersion: { id: v2?.modelVersionId, version: 2 },
        kept: [],
        dropped: [],
        reset: [{ featureKey: 'size', label: 'Size', oldValue: 'l', oldDisplay: 'Large', reason: 'option_removed' }],
      })

      const stored = await readJsonSafe<{ selections: Record<string, unknown>; migration: unknown; sourceSnapshotId: string }>(
        await readSession(request, token, `id=${copy.sessionId}`),
      )
      expect(stored).toMatchObject({ selections: {}, migration: copy.migration, sourceSnapshotId: source.snapshotId })

      const evaluated = await evaluateStoredSelections(request, token, copy.sessionId)
      expect(evaluated.evaluation.finalisable).toBe(true)

      const unconfirmed = await finalise(request, token, { id: copy.sessionId, expectedHash: evaluated.evaluation.hash, revision: evaluated.revision })
      expect(unconfirmed.status()).toBe(422)
      expect(await readJsonSafe<{ code: string; migration: unknown }>(unconfirmed)).toMatchObject({ code: 'migration_unconfirmed', migration: copy.migration })
      expect(configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))).toHaveLength(1)

      const added = await finalise(request, token, {
        id: copy.sessionId,
        expectedHash: evaluated.evaluation.hash,
        revision: evaluated.revision,
        migrationAcknowledged: true,
      })
      expect(added.status(), await added.text()).toBe(200)
      const addedBody = await readJsonSafe<{ quoteLineId: string; outcome: string }>(added)
      expect(addedBody?.outcome).toBe('added')
      const lines = configuredLines(await documentLines(request, token, 'quote', fixture.quoteId))
      expect(lines.map((line) => line.id).sort()).toEqual([source.quoteLineId, addedBody?.quoteLineId].sort())
    } finally {
      await cleanup.run()
    }
  })
})
