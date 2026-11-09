import { buildModelStudioHref, buildModelVersionHref, buildModelsListQuery, resolveModelOpenTarget, resolvePublishState } from '../modelsApi'

describe('modelsApi', () => {
  it('builds the list query from paging, filters and a supported sort', () => {
    const query = new URLSearchParams(
      buildModelsListQuery({
        page: 2,
        filters: { search: '  loader ', published: 'false', currencyCode: 'EUR' },
        sorting: [{ id: 'modelKey', desc: false }],
      }),
    )
    expect(Object.fromEntries(query)).toEqual({
      page: '2',
      pageSize: '25',
      search: 'loader',
      published: 'false',
      currencyCode: 'EUR',
      sortField: 'modelKey',
      sortDir: 'asc',
    })
  })

  it('leaves out empty filters and a sort field the API does not support', () => {
    const query = new URLSearchParams(
      buildModelsListQuery({
        page: 1,
        filters: { search: '   ', published: null, currencyCode: null },
        sorting: [{ id: 'publishState', desc: true }],
      }),
    )
    expect(Object.fromEntries(query)).toEqual({ page: '1', pageSize: '25' })
  })

  it('resolves the publish state from the latest version and the unpublished-changes flag', () => {
    expect(resolvePublishState({ latestVersion: null, hasUnpublishedChanges: false })).toEqual({ kind: 'not_published' })
    const latestVersion = { id: 'v-1', version: 4, hash: 'h', publishedAt: '2026-11-01T10:00:00.000Z' }
    expect(resolvePublishState({ latestVersion, hasUnpublishedChanges: true })).toEqual({
      kind: 'published',
      version: 4,
      hasUnpublishedChanges: true,
    })
  })

  it('links to the studio and to a published version', () => {
    expect(buildModelStudioHref('m-1')).toBe('/backend/product_configurator/models/m-1')
    expect(buildModelVersionHref('m-1', 'v-2')).toBe('/backend/product_configurator/models/m-1/versions/v-2')
  })

  it('opens the studio for a manager and the latest published version for a view-only user', () => {
    const latestVersion = { id: 'v-4', version: 4, hash: 'h', publishedAt: '2026-11-01T10:00:00.000Z' }
    expect(resolveModelOpenTarget({ id: 'm-1', latestVersion }, true)).toEqual({ kind: 'studio', href: '/backend/product_configurator/models/m-1' })
    expect(resolveModelOpenTarget({ id: 'm-1', latestVersion }, false)).toEqual({
      kind: 'version',
      href: '/backend/product_configurator/models/m-1/versions/v-4',
      version: 4,
    })
    expect(resolveModelOpenTarget({ id: 'm-1', latestVersion: null }, false)).toBeNull()
  })
})
