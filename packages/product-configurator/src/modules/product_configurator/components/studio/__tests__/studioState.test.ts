import { build } from '../../../lib/__tests__/fixtures'
import { createStudioState, isDraftDirty, studioReducer, type StudioModelDetail } from '../studioState'
import type { DefinitionUpdater } from '../tabs/types'

const MODEL_ID = '11111111-1111-4111-8111-111111111111'

function detail(overrides: Partial<StudioModelDetail> = {}): StudioModelDetail {
  return {
    id: MODEL_ID,
    title: 'Pump',
    modelKey: 'pump',
    productId: '22222222-2222-4222-8222-222222222222',
    currencyCode: 'EUR',
    latestVersion: null,
    hasUnpublishedChanges: false,
    updatedAt: '2026-11-05T10:00:00.000Z',
    draftDefinition: build(),
    ...overrides,
  }
}

describe('studioReducer', () => {
  it('starts clean with the loaded draft and lock token', () => {
    const state = createStudioState(detail())
    expect(state.draft).not.toBeNull()
    expect(state.lockToken).toBe('2026-11-05T10:00:00.000Z')
    expect(isDraftDirty(state)).toBe(false)
    expect(state.activeTab).toBe('overview')
  })

  it('tracks edits as dirty and is clean again when the edit is reverted', () => {
    const initial = createStudioState(detail())
    const edited = studioReducer(initial, {
      type: 'edit',
      update: (definition) => ({ ...definition, features: definition.features.slice(1) }),
    })
    expect(isDraftDirty(edited)).toBe(true)
    const reverted = studioReducer(edited, { type: 'edit', update: () => initial.savedDefinition! })
    expect(isDraftDirty(reverted)).toBe(false)
  })

  it('discard restores the last saved draft, clears row selection and bumps the epoch', () => {
    const initial = studioReducer(createStudioState(detail()), { type: 'selectKey', tab: 'features', key: 'motor' })
    const edited = studioReducer(initial, { type: 'edit', update: (definition) => ({ ...definition, features: [] }) })
    const discarded = studioReducer(edited, { type: 'discard' })
    expect(isDraftDirty(discarded)).toBe(false)
    expect(discarded.draft?.features).toHaveLength(initial.savedDefinition!.features.length)
    expect(discarded.selectedKeys).toEqual({})
    expect(discarded.epoch).toBe(edited.epoch + 1)
  })

  it('keeps the reference changes of edits until the draft is discarded or loaded again', () => {
    const rename: DefinitionUpdater = (definition) => definition
    const initial = createStudioState(detail())
    expect(initial.referenceChanges).toEqual([])
    const plain = studioReducer(initial, { type: 'edit', update: (definition) => ({ ...definition, features: definition.features.slice(1) }) })
    expect(plain.referenceChanges).toEqual([])
    const renamed = studioReducer(plain, {
      type: 'edit',
      update: (definition) => ({ ...definition, rules: [] }),
      referenceChange: rename,
    })
    expect(renamed.referenceChanges).toEqual([rename])
    const unchanged = studioReducer(renamed, { type: 'edit', update: (definition) => definition, referenceChange: rename })
    expect(unchanged.referenceChanges).toEqual([rename])
    expect(studioReducer(renamed, { type: 'discard' }).referenceChanges).toEqual([])
    expect(studioReducer(renamed, { type: 'loaded', detail: detail() }).referenceChanges).toEqual([])
  })

  const publishedV1 = { id: 'v1', version: 1, hash: 'hash-v1', publishedAt: '2026-11-01T00:00:00.000Z' }

  it('saved takes the new lock token and stays dirty for edits made while the save ran', () => {
    const initial = createStudioState(detail({ latestVersion: publishedV1 }))
    const firstEdit = studioReducer(initial, { type: 'edit', update: (definition) => ({ ...definition, features: [] }) })
    const sent = firstEdit.draft!
    const secondEdit = studioReducer(firstEdit, { type: 'edit', update: (definition) => ({ ...definition, fixedSpecification: [] }) })
    const saved = studioReducer(secondEdit, { type: 'saved', definition: sent, updatedAt: '2026-11-05T11:00:00.000Z', draftHash: 'hash-edited' })
    expect(saved.lockToken).toBe('2026-11-05T11:00:00.000Z')
    expect(saved.savedDefinition).toBe(sent)
    expect(isDraftDirty(saved)).toBe(true)
    expect(saved.model.hasUnpublishedChanges).toBe(true)
  })

  it('saved compares the returned draft hash with the latest version hash', () => {
    const initial = createStudioState(detail({ latestVersion: publishedV1, hasUnpublishedChanges: true }))
    const definition = initial.draft!
    const backToPublished = studioReducer(initial, { type: 'saved', definition, updatedAt: '2026-11-05T11:00:00.000Z', draftHash: 'hash-v1' })
    expect(backToPublished.model.hasUnpublishedChanges).toBe(false)

    const neverPublished = createStudioState(detail())
    const savedUnpublished = studioReducer(neverPublished, { type: 'saved', definition, updatedAt: '2026-11-05T11:00:00.000Z', draftHash: 'any' })
    expect(savedUnpublished.model.hasUnpublishedChanges).toBe(false)
  })

  it('a save after publishing compares with the hash of the version just published', () => {
    const published = studioReducer(createStudioState(detail()), {
      type: 'published',
      published: { version: 1, modelVersionId: 'v1', hash: 'hash-v1' },
      updatedAt: '2026-11-05T12:00:00.000Z',
      publishedAt: '2026-11-05T12:00:00.000Z',
    })
    const definition = published.draft!
    const unchanged = studioReducer(published, { type: 'saved', definition, updatedAt: '2026-11-05T12:01:00.000Z', draftHash: 'hash-v1' })
    expect(unchanged.model.hasUnpublishedChanges).toBe(false)
    const changed = studioReducer(published, { type: 'saved', definition, updatedAt: '2026-11-05T12:01:00.000Z', draftHash: 'hash-v2' })
    expect(changed.model.hasUnpublishedChanges).toBe(true)
  })

  it('published uses the response updatedAt as the next lock token', () => {
    const state = studioReducer(createStudioState(detail()), {
      type: 'published',
      published: { version: 3, modelVersionId: 'v3', hash: 'hash-v3' },
      updatedAt: '2026-11-05T12:00:00.000Z',
      publishedAt: '2026-11-05T12:00:00.000Z',
    })
    expect(state.lockToken).toBe('2026-11-05T12:00:00.000Z')
    expect(state.model.latestVersion?.version).toBe(3)
    expect(state.model.hasUnpublishedChanges).toBe(false)
    expect(state.published?.version).toBe(3)
  })

  it('opens a draft that does not parse in repair mode and lets a replaced draft be saved', () => {
    const state = createStudioState(detail({ draftDefinition: { schemaVersion: 1, features: 'broken' } }))
    expect(state.draft).toBeNull()
    expect(state.activeTab).toBe('advanced')
    expect(isDraftDirty(state)).toBe(false)
    const repaired = studioReducer(state, { type: 'replace', definition: build() })
    expect(repaired.draft).not.toBeNull()
    expect(isDraftDirty(repaired)).toBe(true)
  })

  it('loaded after a conflict replaces the draft and keeps the active tab', () => {
    const edited = studioReducer(
      studioReducer(createStudioState(detail()), { type: 'selectTab', tab: 'features' }),
      { type: 'edit', update: (definition) => ({ ...definition, features: [] }) },
    )
    const conflicted = studioReducer(edited, { type: 'conflict' })
    const reloaded = studioReducer(conflicted, { type: 'loaded', detail: detail({ updatedAt: '2026-11-05T13:00:00.000Z' }) })
    expect(isDraftDirty(reloaded)).toBe(false)
    expect(reloaded.conflict).toBe(false)
    expect(reloaded.lockToken).toBe('2026-11-05T13:00:00.000Z')
    expect(reloaded.activeTab).toBe('features')
  })

  it('loaded with a saved draft that does not parse switches to Advanced, like discard does', () => {
    const onFeatures = studioReducer(createStudioState(detail()), { type: 'selectTab', tab: 'features' })
    const reloaded = studioReducer(onFeatures, {
      type: 'loaded',
      detail: detail({ draftDefinition: { schemaVersion: 1, features: 'broken' } }),
    })
    expect(reloaded.draft).toBeNull()
    expect(reloaded.activeTab).toBe('advanced')
    expect(studioReducer(reloaded, { type: 'discard' }).activeTab).toBe('advanced')
  })
})
