"use client"

import * as React from 'react'
import { z } from 'zod'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LookupSinglePicker } from '@open-mercato/ui/backend/inputs/LookupPickers'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { createCrudFormError } from '@open-mercato/ui/backend/utils/serverErrors'
import { Button } from '@open-mercato/ui/primitives/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { MODEL_KEY_PATTERN } from '../../data/validators'
import { activePriceKindLookupSource, loadCurrencyOptions, productLookupSource } from './lookups'
import { MODELS_API_PATH } from './modelsApi'

const REQUIRED_MESSAGE = 'ui.forms.errors.required'

export const modelCreateFormSchema = z.object({
  title: z.string().trim().min(1, REQUIRED_MESSAGE).max(200),
  modelKey: z
    .string()
    .trim()
    .min(1, REQUIRED_MESSAGE)
    .max(100)
    .regex(MODEL_KEY_PATTERN, 'product_configurator.models.create.errors.keyInvalid'),
  productId: z.string().uuid(REQUIRED_MESSAGE),
  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'product_configurator.models.create.errors.currencyInvalid'),
  priceKindId: z.string().uuid(REQUIRED_MESSAGE),
})

export type ModelCreateFormValues = z.infer<typeof modelCreateFormSchema>

const INITIAL_VALUES: ModelCreateFormValues = { title: '', modelKey: '', productId: '', currencyCode: '', priceKindId: '' }

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

type ModelCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (modelId: string) => void
}

export function ModelCreateDialog({ open, onOpenChange, onCreated }: ModelCreateDialogProps) {
  const t = useT()

  const fields = React.useMemo<CrudField[]>(
    () => [
      {
        id: 'title',
        type: 'text',
        label: t('product_configurator.models.create.fields.title', 'Title'),
        required: true,
        maxLength: 200,
      },
      {
        id: 'modelKey',
        type: 'text',
        label: t('product_configurator.models.create.fields.key', 'Key'),
        description: t(
          'product_configurator.models.create.fields.keyHint',
          'Unique in the organization. Letters, digits, dashes and underscores. It cannot be changed later.',
        ),
        required: true,
        maxLength: 100,
      },
      {
        id: 'productId',
        type: 'custom',
        label: t('product_configurator.models.create.fields.product', 'Catalog product'),
        description: t(
          'product_configurator.models.create.fields.productHint',
          'The product that configured quote lines are written for.',
        ),
        required: true,
        component: ({ value, setValue, disabled }) => (
          <LookupSinglePicker
            source={productLookupSource}
            value={typeof value === 'string' ? value : ''}
            onChange={setValue}
            disabled={disabled}
            placeholder={t('product_configurator.models.create.fields.productPlaceholder', 'Search products')}
          />
        ),
      },
      {
        id: 'currencyCode',
        type: 'combobox',
        label: t('product_configurator.models.create.fields.currency', 'Currency'),
        description: t(
          'product_configurator.models.create.fields.currencyHint',
          'Three-letter ISO code, for example EUR. Only quotes in this currency can use the model.',
        ),
        placeholder: t('product_configurator.models.create.fields.currencyPlaceholder', 'EUR'),
        required: true,
        allowCustomValues: true,
        loadOptions: loadCurrencyOptions,
        layout: 'half',
      },
      {
        id: 'priceKindId',
        type: 'custom',
        label: t('product_configurator.models.create.fields.priceKind', 'Price kind'),
        description: t(
          'product_configurator.models.create.fields.priceKindHint',
          'The catalog price list used to price the parts.',
        ),
        required: true,
        layout: 'half',
        component: ({ value, setValue, disabled }) => (
          <LookupSinglePicker
            source={activePriceKindLookupSource}
            value={typeof value === 'string' ? value : ''}
            onChange={setValue}
            disabled={disabled}
            placeholder={t('product_configurator.models.create.fields.priceKindPlaceholder', 'Select a price kind')}
          />
        ),
      },
    ],
    [t],
  )

  const handleSubmit = React.useCallback(
    async (values: ModelCreateFormValues) => {
      const payload = modelCreateFormSchema.parse(values)
      try {
        const call = await createCrud<{ id?: string | null }>(MODELS_API_PATH, payload, {
          errorMessage: t('product_configurator.models.create.errors.failed', 'Failed to create the model.'),
        })
        const createdId = call.result?.id
        flash(t('product_configurator.models.create.success', 'Model created'), 'success')
        onOpenChange(false)
        if (typeof createdId === 'string' && createdId) onCreated(createdId)
      } catch (error) {
        if (readErrorCode(error) !== 'duplicate_model_key') throw error
        const message = t('product_configurator.errors.duplicate_model_key', 'A configuration model with this key already exists.')
        throw createCrudFormError(message, { modelKey: message })
      }
    },
    [onCreated, onOpenChange, t],
  )

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
    const form = event.currentTarget.querySelector('form')
    if (!form) return
    event.preventDefault()
    form.requestSubmit()
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>{t('product_configurator.models.create.title', 'Create configuration model')}</DialogTitle>
          <DialogDescription>
            {t(
              'product_configurator.models.create.description',
              'The model starts as an empty draft. Add features, rules and the BOM in the studio, then publish it.',
            )}
          </DialogDescription>
        </DialogHeader>
        <CrudForm<ModelCreateFormValues>
          schema={modelCreateFormSchema}
          fields={fields}
          initialValues={INITIAL_VALUES}
          submitLabel={t('product_configurator.models.create.submit', 'Create model')}
          onSubmit={handleSubmit}
          extraActions={(
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('product_configurator.models.create.cancel', 'Cancel')}
            </Button>
          )}
          embedded
        />
      </DialogContent>
    </Dialog>
  )
}
