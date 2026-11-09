/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { render } from '@testing-library/react'
import { ModelCreateDialog, modelCreateFormSchema, type ModelCreateFormValues } from '../ModelCreateDialog'

const createCrudMock = jest.fn()
const flashMock = jest.fn()
const loadPriceKindCurrencyMock = jest.fn()
const loadCurrencyOptionsMock = jest.fn(async () => [])
let grantedFeatures: string[] = ['product_configurator.models.manage', 'currencies.view']

type CapturedFormProps = {
  fields: Array<{ id: string; type: string; required?: boolean; loadOptions?: unknown }>
  entityId?: string
  embedded?: boolean
  initialValues: ModelCreateFormValues
  onSubmit: (values: ModelCreateFormValues) => Promise<void>
}

let crudFormProps: CapturedFormProps | null = null

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}))

jest.mock('@open-mercato/ui/backend/BackendChromeProvider', () => ({
  useBackendChrome: () => ({ payload: { grantedFeatures } }),
}))

jest.mock('@open-mercato/ui/backend/FlashMessages', () => ({ flash: (...args: unknown[]) => flashMock(...args) }))

jest.mock('@open-mercato/ui/backend/utils/crud', () => ({
  createCrud: (...args: unknown[]) => createCrudMock(...args),
}))

jest.mock('@open-mercato/ui/backend/inputs/LookupPickers', () => ({ LookupSinglePicker: () => null }))

jest.mock('../lookups', () => ({
  productLookupSource: { id: 'products', search: jest.fn(), resolve: jest.fn() },
  activePriceKindLookupSource: { id: 'price-kinds', search: jest.fn(), resolve: jest.fn() },
  loadCurrencyOptions: (...args: unknown[]) => loadCurrencyOptionsMock(...args),
  loadPriceKindCurrency: (...args: unknown[]) => loadPriceKindCurrencyMock(...args),
}))

jest.mock('@open-mercato/ui/backend/CrudForm', () => ({
  CrudForm: (props: CapturedFormProps) => {
    crudFormProps = props
    return null
  },
}))

const PRODUCT_ID = '3f9c0e0a-6a4b-4d55-9c1f-2b7d8e9f0a11'
const PRICE_KIND_ID = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'

const validValues: ModelCreateFormValues = {
  title: ' Telescopic loader TL-500 ',
  modelKey: 'tl-500',
  productId: PRODUCT_ID,
  currencyCode: 'eur',
  priceKindId: PRICE_KIND_ID,
}

describe('ModelCreateDialog', () => {
  beforeEach(() => {
    createCrudMock.mockReset()
    flashMock.mockReset()
    loadPriceKindCurrencyMock.mockReset()
    loadPriceKindCurrencyMock.mockResolvedValue(null)
    loadCurrencyOptionsMock.mockClear()
    grantedFeatures = ['product_configurator.models.manage', 'currencies.view']
    crudFormProps = null
  })

  it('renders an embedded CrudForm with the five required model fields', () => {
    render(<ModelCreateDialog open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    expect(crudFormProps?.embedded).toBe(true)
    expect(crudFormProps?.entityId).toBeUndefined()
    expect(crudFormProps?.fields.map((field) => field.id)).toEqual(['title', 'modelKey', 'productId', 'currencyCode', 'priceKindId'])
    expect(crudFormProps?.fields.every((field) => field.required)).toBe(true)
  })

  it('offers currency suggestions only to users who can view currencies', async () => {
    const { rerender } = render(<ModelCreateDialog open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    const currencyField = () => crudFormProps?.fields.find((field) => field.id === 'currencyCode')
    expect(typeof currencyField()?.loadOptions).toBe('function')

    grantedFeatures = ['product_configurator.models.manage', 'catalog.products.view']
    rerender(<ModelCreateDialog open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    expect(currencyField()?.loadOptions).toBeUndefined()
    expect(loadCurrencyOptionsMock).not.toHaveBeenCalled()

    createCrudMock.mockResolvedValue({ ok: true, result: { id: 'model-9' } })
    await crudFormProps?.onSubmit(validValues)
    expect(createCrudMock).toHaveBeenCalledWith('product_configurator/models', expect.objectContaining({ currencyCode: 'EUR' }), expect.anything())
    expect(flashMock).toHaveBeenCalledTimes(1)
    expect(flashMock).toHaveBeenCalledWith('Model created', 'success')
  })

  it('validates the key pattern, the currency code and the picked ids', () => {
    expect(modelCreateFormSchema.safeParse(validValues).success).toBe(true)
    const invalid = modelCreateFormSchema.safeParse({ ...validValues, modelKey: '-bad key', currencyCode: 'EURO', productId: '' })
    expect(invalid.success).toBe(false)
    const messages = invalid.success ? [] : invalid.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`)
    expect(messages).toEqual(
      expect.arrayContaining([
        'modelKey:product_configurator.models.create.errors.keyInvalid',
        'currencyCode:product_configurator.models.create.errors.currencyInvalid',
        'productId:ui.forms.errors.required',
      ]),
    )
  })

  it('creates the model with a normalized payload, closes and hands the new id over', async () => {
    createCrudMock.mockResolvedValue({ ok: true, result: { id: 'model-9' } })
    const onOpenChange = jest.fn()
    const onCreated = jest.fn()
    render(<ModelCreateDialog open onOpenChange={onOpenChange} onCreated={onCreated} />)
    await crudFormProps?.onSubmit(validValues)
    expect(createCrudMock).toHaveBeenCalledWith(
      'product_configurator/models',
      { title: 'Telescopic loader TL-500', modelKey: 'tl-500', productId: PRODUCT_ID, currencyCode: 'EUR', priceKindId: PRICE_KIND_ID },
      expect.objectContaining({ errorMessage: 'Failed to create the model.' }),
    )
    expect(flashMock).toHaveBeenCalledWith('Model created', 'success')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onCreated).toHaveBeenCalledWith('model-9')
  })

  it('refuses a price kind bound to another currency than the model', async () => {
    loadPriceKindCurrencyMock.mockResolvedValue('USD')
    render(<ModelCreateDialog open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    await expect(crudFormProps?.onSubmit(validValues)).rejects.toMatchObject({
      fieldErrors: { priceKindId: 'This price kind is for {priceKindCurrency}. Pick one for {currencyCode} or one without a currency.' },
    })
    expect(loadPriceKindCurrencyMock).toHaveBeenCalledWith(PRICE_KIND_ID)
    expect(createCrudMock).not.toHaveBeenCalled()

    loadPriceKindCurrencyMock.mockResolvedValue('EUR')
    createCrudMock.mockResolvedValue({ ok: true, result: { id: 'model-9' } })
    await crudFormProps?.onSubmit(validValues)
    expect(createCrudMock).toHaveBeenCalled()
  })

  it('maps a duplicate key to the key field', async () => {
    createCrudMock.mockRejectedValue(Object.assign(new Error('taken'), { code: 'duplicate_model_key', status: 409 }))
    const onCreated = jest.fn()
    render(<ModelCreateDialog open onOpenChange={jest.fn()} onCreated={onCreated} />)
    await expect(crudFormProps?.onSubmit(validValues)).rejects.toMatchObject({
      fieldErrors: { modelKey: 'A configuration model with this key already exists.' },
    })
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('passes other failures through unchanged', async () => {
    const failure = Object.assign(new Error('boom'), { status: 500 })
    createCrudMock.mockRejectedValue(failure)
    render(<ModelCreateDialog open onOpenChange={jest.fn()} onCreated={jest.fn()} />)
    await expect(crudFormProps?.onSubmit(validValues)).rejects.toBe(failure)
  })
})
