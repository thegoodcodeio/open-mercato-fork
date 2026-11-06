/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { render } from '@testing-library/react'
import { build } from '../../../lib/__tests__/fixtures'
import type { StudioTabProps } from '../tabs/types'

// jsdom has no TextEncoder; the definition schema measures the draft size with it.
Object.assign(globalThis, { TextEncoder })

type CapturedField = { id: string; type: string; component?: (props: Record<string, unknown>) => React.ReactNode }
type CapturedFormProps = { trackDirtyWhenEmbedded?: boolean; embedded?: boolean; fields: CapturedField[] }

let formProps: CapturedFormProps | null = null
let titleValue = 'Pump'

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}))

jest.mock('@open-mercato/ui/backend/CrudForm', () => ({
  CrudForm: (props: CapturedFormProps) => {
    formProps = props
    const title = props.fields.find((field) => field.id === 'title')
    return <>{title?.component?.({ id: 'title', value: titleValue, setValue: () => undefined })}</>
  },
}))

jest.mock('../useCatalogLabels', () => ({ useCatalogLabels: () => ({ product: null, priceKind: null }) }))

import { OverviewTab } from '../tabs/OverviewTab'

describe('OverviewTab', () => {
  it('reports an unsaved title edit to the studio and clears it after save and on unmount', () => {
    const definition = build()
    const onDirtyChange = jest.fn()
    const props: StudioTabProps = {
      model: {
        id: 'model-1',
        title: 'Pump',
        modelKey: 'pump',
        productId: 'product-1',
        currencyCode: 'EUR',
        latestVersion: null,
        hasUnpublishedChanges: false,
      },
      definition,
      savedDefinition: definition,
      onChange: jest.fn(),
      readOnly: false,
      issues: [],
      selectedKey: null,
      onSelectKey: jest.fn(),
      onNavigate: jest.fn(),
      lockToken: null,
      onModelSaved: jest.fn(),
      onConflict: jest.fn(),
    }
    const view = render(<OverviewTab {...props} onDirtyChange={onDirtyChange} />)
    expect(formProps?.embedded).toBe(true)
    expect(formProps?.trackDirtyWhenEmbedded).toBeUndefined()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    titleValue = 'Pump XL'
    view.rerender(<OverviewTab {...props} onDirtyChange={onDirtyChange} />)
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    view.rerender(<OverviewTab {...props} model={{ ...props.model, title: 'Pump XL' }} onDirtyChange={onDirtyChange} />)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    view.rerender(<OverviewTab {...props} onDirtyChange={onDirtyChange} />)
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    view.unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })
})
