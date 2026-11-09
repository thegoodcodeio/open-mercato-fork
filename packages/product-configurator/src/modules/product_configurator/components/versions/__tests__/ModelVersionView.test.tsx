/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { buildReferenceDefinition } from '../../../lib/referenceModel'
import { ModelVersionView, type ModelVersionDetail } from '../ModelVersionView'

const apiCallMock = jest.fn()
let grantedFeatures: string[] = ['product_configurator.models.view', 'product_configurator.models.manage']

// jsdom does not provide TextEncoder, which the definition schema uses to measure the definition size.
Object.assign(globalThis, { TextEncoder: NodeTextEncoder })

jest.mock('@open-mercato/shared/lib/i18n/context', () => {
  const translate = (key: string, fallback?: string, params?: Record<string, string | number>) => {
    const text = fallback ?? key
    return params ? text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? '')) : text
  }
  return { useT: () => translate, useOptionalT: () => translate, useLocale: () => 'en' }
})

jest.mock('@open-mercato/shared/lib/frontend/useOrganizationScope', () => ({
  useOrganizationScopeVersion: () => 0,
}))

jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({
  useBackendChrome: () => ({ payload: { grantedFeatures } }),
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  LoadingMessage: ({ label }: { label: string }) => <div data-testid="loading">{label}</div>,
  ErrorMessage: ({ label, action }: { label: string; action?: React.ReactNode }) => (
    <div role="alert">
      {label}
      {action}
    </div>
  ),
  RecordNotFoundState: ({ label, backHref }: { label: string; backHref?: string }) => (
    <div data-testid="not-found" data-back={backHref}>
      {label}
    </div>
  ),
}))

jest.mock('@open-mercato/ui/backend/forms', () => ({
  FormHeader: ({ title, backHref }: { title?: React.ReactNode; backHref?: string }) => (
    <header data-back={backHref}>
      <h1>{title}</h1>
    </header>
  ),
}))

const MODEL_ID = 'c1d2e3f4-0000-4000-8000-000000000001'
const VERSION_ID = 'c1d2e3f4-0000-4000-8000-000000000002'
const PRICE_KIND_ID = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'

function buildVersion(overrides: Partial<ModelVersionDetail> = {}): ModelVersionDetail {
  return {
    id: VERSION_ID,
    modelId: MODEL_ID,
    version: 3,
    hash: 'f'.repeat(64),
    publishedAt: '2026-11-01T10:00:00.000Z',
    definition: buildReferenceDefinition({ currencyCode: 'USD', priceKindId: PRICE_KIND_ID }),
    ...overrides,
  }
}

describe('ModelVersionView', () => {
  beforeEach(() => {
    apiCallMock.mockReset()
    grantedFeatures = ['product_configurator.models.view', 'product_configurator.models.manage']
  })

  it('loads the version by id and renders its summary and definition tables read-only', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: buildVersion() })
    render(<ModelVersionView modelId={MODEL_ID} versionId={VERSION_ID} />)
    expect(screen.getByTestId('loading')).toBeTruthy()

    expect(await screen.findByRole('heading', { name: 'Version 3' })).toBeTruthy()
    expect(String(apiCallMock.mock.calls[0][0])).toBe(`/api/product_configurator/model-versions?id=${VERSION_ID}`)
    expect(screen.getByText('f'.repeat(64))).toBeTruthy()
    expect(screen.getByText('USD')).toBeTruthy()
    for (const section of ['Features', 'Formulas', 'Lookups', 'Rules', 'BOM']) {
      expect(screen.getByRole('button', { name: `Collapse ${section} section` })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: 'Expand Definition (JSON) section' })).toBeTruthy()
    expect(screen.getByText('Paint')).toBeTruthy()
    expect(screen.getByText('Long hose runs need auxiliary hydraulics')).toBeTruthy()
    expect(screen.getAllByText('feature.cab = "enclosed"').length).toBeGreaterThan(0)
    expect(screen.getByText('feature.aux_hydraulics := true')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('banner').getAttribute('data-back')).toBe(`/backend/product_configurator/models/${MODEL_ID}`)
  })

  it('links a view-only user back to the list instead of the manage-only studio', async () => {
    grantedFeatures = ['product_configurator.models.view']
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: buildVersion() })
    render(<ModelVersionView modelId={MODEL_ID} versionId={VERSION_ID} />)
    await screen.findByRole('heading', { name: 'Version 3' })
    expect(screen.getByRole('banner').getAttribute('data-back')).toBe('/backend/product_configurator/models')
  })

  it('shows the unit of every feature and the options next to a lookup reference', async () => {
    const definition = buildReferenceDefinition({ currencyCode: 'USD', priceKindId: PRICE_KIND_ID })
    const features = definition.features.map((feature) =>
      feature.key === 'paint' ? { ...feature, unit: 'coat', optionsFromLookup: 'paint_codes' } : feature,
    )
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: buildVersion({ definition: { ...definition, features } }) })
    render(<ModelVersionView modelId={MODEL_ID} versionId={VERSION_ID} />)
    await screen.findByRole('heading', { name: 'Version 3' })
    expect(screen.getByText('coat')).toBeTruthy()
    expect(screen.getByText('From lookup paint_codes')).toBeTruthy()
  })

  it('shows the not-found state for a malformed id without calling the API', async () => {
    render(<ModelVersionView modelId={MODEL_ID} versionId="not-a-version" />)
    expect(await screen.findByTestId('not-found')).toBeTruthy()
    expect(apiCallMock).not.toHaveBeenCalled()
  })

  it('shows the JSON on demand', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: buildVersion() })
    render(<ModelVersionView modelId={MODEL_ID} versionId={VERSION_ID} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Definition (JSON) section' }))
    expect(screen.getByText(/"schemaVersion": 1/)).toBeTruthy()
  })

  it('falls back to the JSON when the definition cannot be read as tables', async () => {
    apiCallMock.mockResolvedValue({ ok: true, status: 200, result: buildVersion({ definition: { schemaVersion: 2 } }) })
    render(<ModelVersionView modelId={MODEL_ID} versionId={VERSION_ID} />)
    expect(await screen.findByText(/cannot be shown as tables/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Collapse Features section' })).toBeNull()
  })

  it('treats a missing version and a version of another model as not found', async () => {
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 404, result: { code: 'version_not_found' } })
    const { unmount } = render(<ModelVersionView modelId={MODEL_ID} versionId={VERSION_ID} />)
    expect((await screen.findByTestId('not-found')).getAttribute('data-back')).toBe('/backend/product_configurator/models')
    unmount()

    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: buildVersion({ modelId: 'another-model' }) })
    render(<ModelVersionView modelId={MODEL_ID} versionId={VERSION_ID} />)
    expect(await screen.findByTestId('not-found')).toBeTruthy()
  })

  it('shows an error with retry for other failures', async () => {
    apiCallMock.mockResolvedValueOnce({ ok: false, status: 500, result: null })
    apiCallMock.mockResolvedValueOnce({ ok: true, status: 200, result: buildVersion() })
    render(<ModelVersionView modelId={MODEL_ID} versionId={VERSION_ID} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to load the published version.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Version 3' })).toBeTruthy())
  })
})
