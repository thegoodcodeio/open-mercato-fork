/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { StudioHeader } from '../StudioHeader'
import type { StudioModelInfo } from '../tabs/types'

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string, params?: Record<string, string | number>) => {
    const text = fallback ?? key
    return params ? text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? '')) : text
  },
}))

jest.mock('../useCatalogLabels', () => ({ useCatalogLabels: () => ({ product: null, priceKind: null }) }))

const MODEL: StudioModelInfo = {
  id: 'model-1',
  title: 'Telehandler',
  modelKey: 'th-3510',
  productId: 'product-1',
  currencyCode: 'EUR',
  latestVersion: null,
  hasUnpublishedChanges: true,
}

function renderHeader(model: StudioModelInfo, localDirty = false, modelMissing = false) {
  return render(
    <StudioHeader
      model={model}
      priceKindId={null}
      dirty={false}
      localDirty={localDirty}
      canSave={!modelMissing}
      modelMissing={modelMissing}
      busy={null}
      onDiscard={jest.fn()}
      onSave={jest.fn()}
      onValidate={jest.fn()}
      onPublish={jest.fn()}
    />,
  )
}

describe('StudioHeader', () => {
  it('links to the latest published version', () => {
    renderHeader({ ...MODEL, latestVersion: { id: 'v-2', version: 2, hash: 'h', publishedAt: '2026-11-01T10:00:00.000Z' } })
    expect(screen.getByRole('link', { name: 'View published v2' }).getAttribute('href')).toBe(
      '/backend/product_configurator/models/model-1/versions/v-2',
    )
  })

  it('asks to finish the open editor for edits outside the draft without enabling Save draft', () => {
    renderHeader(MODEL, true)
    expect(screen.getByText('Save or cancel the open editor first.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save draft' }).hasAttribute('disabled')).toBe(true)
  })

  it('disables every action that needs the model once it was deleted', () => {
    renderHeader(MODEL, false, true)
    for (const name of ['Save draft', 'Validate', 'Publish']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
    }
  })

  it('has no version link before the first publish', () => {
    renderHeader(MODEL)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
