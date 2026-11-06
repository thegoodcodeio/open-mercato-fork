"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { ForbiddenError } from '@open-mercato/ui/backend/utils/api'
import { apiCall, apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { Button } from '@open-mercato/ui/primitives/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import {
  COMMENT_MAX_LENGTH,
  LINES_UPDATE_API,
  NAME_MAX_LENGTH,
  QUOTE_RESOURCE_KIND,
  TAX_KEEP,
  TAX_NONE,
  TAX_RATES_URL,
  buildLineUpdateBody,
  initialLineForm,
  lineUpdateResponseSchema,
  parseQuoteLine,
  parseTaxRates,
  quoteLineUrl,
  validateLineForm,
  type DiscountMode,
  type LineDetailsForm,
  type LineFormErrors,
  type QuoteLineDetails,
  type TaxRateOption,
} from './lineDetailsApi'

type LineMutationContext = { formId: string; resourceKind: string; resourceId: string; retryLastMutation: () => Promise<boolean> }

const DISCOUNT_MODES: readonly DiscountMode[] = ['none', 'percent', 'amount']

function isDiscountMode(value: string): value is DiscountMode {
  return DISCOUNT_MODES.some((mode) => mode === value)
}

/** Tax rates are sales settings: without access, or while they cannot be loaded, the current tax is kept. */
type TaxRatesLoad = { status: 'loading' } | { status: 'not_permitted' } | { status: 'failed' } | { status: 'ready'; rates: TaxRateOption[] }

type DialogLoad =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'missing' }
  | { status: 'ready'; line: QuoteLineDetails; taxRates: TaxRatesLoad; initial: LineDetailsForm }

type LineDetailsDialogProps = {
  quoteId: string
  lineId: string
  currencyCode: string
  /** `GET /api/sales/tax-rates` needs `sales.settings.manage`; without it the rates are not read. */
  canReadTaxRates: boolean
  /** Quote `updatedAt`, sent as the optimistic lock header. */
  lockToken: string | null
  onClose: () => void
  /** The line was saved; `updatedAt` is the quote's new lock token. */
  onSaved: (updatedAt: string | null) => void
  /** The quote changed elsewhere: the conflict bar is shown, the quote reloads and the dialog closes. */
  onConflict: () => void
}

async function loadTaxRates(canRead: boolean): Promise<TaxRatesLoad> {
  if (!canRead) return { status: 'not_permitted' }
  try {
    const call = await apiCall<unknown>(TAX_RATES_URL, { cache: 'no-store' })
    const rates = call.ok ? parseTaxRates(call.result) : null
    return rates ? { status: 'ready', rates } : { status: 'failed' }
  } catch (error) {
    if (error instanceof ForbiddenError) return { status: 'not_permitted' }
    return { status: 'failed' }
  }
}

function readyRates(taxRates: TaxRatesLoad): TaxRateOption[] | null {
  return taxRates.status === 'ready' ? taxRates.rates : null
}

async function loadDialog(quoteId: string, lineId: string, canReadTaxRates: boolean): Promise<DialogLoad> {
  const [lineCall, taxRates] = await Promise.all([
    apiCall<unknown>(quoteLineUrl(quoteId, lineId), { cache: 'no-store' }),
    loadTaxRates(canReadTaxRates),
  ])
  if (!lineCall.ok) return { status: 'error' }
  const line = parseQuoteLine(lineCall.result, lineId)
  if (!line) return { status: 'missing' }
  return { status: 'ready', line, taxRates, initial: initialLineForm(line, readyRates(taxRates)) }
}

/**
 * "Edit line details" of a configured quote line: name, comment, discount and tax through `POST /lines/update`.
 * Quantity, unit and the configured net price are read-only. Escape cancels, Cmd/Ctrl+Enter saves.
 */
export function LineDetailsDialog({ quoteId, lineId, currencyCode, canReadTaxRates, lockToken, onClose, onSaved, onConflict }: LineDetailsDialogProps) {
  const t = useT()
  const locale = useLocale()
  const contextId = `product_configurator.line-details:${quoteId}`
  const { runMutation, retryLastMutation } = useGuardedMutation<LineMutationContext>({
    contextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })
  const [load, setLoad] = React.useState<DialogLoad>({ status: 'loading' })
  const [reloadToken, setReloadToken] = React.useState(0)
  const [form, setForm] = React.useState<LineDetailsForm | null>(null)
  const [submitted, setSubmitted] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const loadGeneration = React.useRef(0)

  React.useEffect(() => {
    let cancelled = false
    loadGeneration.current += 1
    setLoad({ status: 'loading' })
    loadDialog(quoteId, lineId, canReadTaxRates).then(
      (next) => {
        if (cancelled) return
        setLoad(next)
        setForm(next.status === 'ready' ? next.initial : null)
      },
      () => {
        if (!cancelled) setLoad({ status: 'error' })
      },
    )
    return () => {
      cancelled = true
      loadGeneration.current += 1
    }
  }, [quoteId, lineId, canReadTaxRates, reloadToken])

  /** Reloads only the tax rates, so the values already entered stay. A reload or close meanwhile drops the answer. */
  const retryTaxRates = async () => {
    if (load.status !== 'ready') return
    const { line, initial } = load
    const generation = loadGeneration.current
    setLoad({ ...load, taxRates: { status: 'loading' } })
    const taxRates = await loadTaxRates(canReadTaxRates)
    if (generation !== loadGeneration.current) return
    const taxChoice = initialLineForm(line, readyRates(taxRates)).taxChoice
    setLoad({ status: 'ready', line, taxRates, initial: { ...initial, taxChoice } })
    setForm((current) => (current && current.taxChoice === initial.taxChoice ? { ...current, taxChoice } : current))
  }

  const errors: LineFormErrors = form ? validateLineForm(form) : {}
  const body = load.status === 'ready' && form ? buildLineUpdateBody(quoteId, lineId, load.initial, form) : null
  const canSave = Boolean(body) && Object.keys(errors).length === 0 && !saving

  const errorText = (code: LineFormErrors[keyof LineFormErrors]) => {
    switch (code) {
      case 'required':
        return t('product_configurator.lineDetails.errors.nameRequired', 'Enter a name.')
      case 'too_long':
        return t('product_configurator.lineDetails.errors.tooLong', 'This text is too long.')
      case 'invalid_percent':
        return t('product_configurator.lineDetails.errors.percent', 'Enter a percentage above 0 and up to 100.')
      case 'invalid_amount':
        return t('product_configurator.lineDetails.errors.amount', 'Enter an amount above 0.')
      default:
        return undefined
    }
  }

  const save = async () => {
    setSubmitted(true)
    if (!body || !canSave || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const call = await runMutation({
        operation: () =>
          withScopedApiRequestHeaders(buildOptimisticLockHeader(lockToken), () =>
            apiCallOrThrow<unknown>(LINES_UPDATE_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          ),
        context: { formId: contextId, resourceKind: QUOTE_RESOURCE_KIND, resourceId: quoteId, retryLastMutation },
        mutationPayload: body,
      })
      const saved = lineUpdateResponseSchema.safeParse(call.result)
      flash(t('product_configurator.lineDetails.saved', 'Line details saved.'), 'success')
      onSaved(saved.success ? saved.data.updatedAt : null)
    } catch (error) {
      if (surfaceRecordConflict(error, t, { onRefresh: onConflict })) {
        onConflict()
        onClose()
        return
      }
      const message = error instanceof Error && error.message.trim() ? error.message : t('product_configurator.lineDetails.saveFailed', 'Could not save the line details.')
      flash(message, 'error')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const update = (patch: Partial<LineDetailsForm>) => setForm((current) => (current ? { ...current, ...patch } : current))

  const renderBody = () => {
    if (load.status === 'loading') return <LoadingMessage label={t('product_configurator.lineDetails.loading', 'Loading the line...')} />
    if (load.status === 'missing') {
      return <ErrorMessage label={t('product_configurator.lineDetails.missing', 'This line is no longer on the quote.')} />
    }
    if (load.status === 'error' || !form) {
      return (
        <ErrorMessage
          label={t('product_configurator.lineDetails.loadFailed', 'Could not load the line.')}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
              {t('product_configurator.configurator.retry', 'Retry')}
            </Button>
          }
        />
      )
    }
    const { line, taxRates } = load
    const rates = readyRates(taxRates)
    const taxNoteId = rates === null ? `${contextId}-tax-note` : undefined
    const discountError = form.discountValue.trim() || submitted ? errorText(errors.discountValue) : undefined
    const currentTax = t('product_configurator.lineDetails.taxCurrent', 'Keep the current tax ({rate} %)', { rate: line.taxRate })
    return (
      <div className="space-y-4">
        <FormField label={t('product_configurator.lineDetails.name', 'Name')} required error={errorText(errors.name)}>
          <Input value={form.name} maxLength={NAME_MAX_LENGTH} onChange={(event) => update({ name: event.target.value })} />
        </FormField>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${contextId}-tax`}>{t('product_configurator.lineDetails.tax', 'Tax rate')}</Label>
          <Select value={form.taxChoice} disabled={rates === null} onValueChange={(taxChoice) => update({ taxChoice })}>
            <SelectTrigger id={`${contextId}-tax`} aria-describedby={taxNoteId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TAX_KEEP}>{currentTax}</SelectItem>
              <SelectItem value={TAX_NONE}>{t('product_configurator.lineDetails.taxNone', 'No tax rate (0 %)')}</SelectItem>
              {(rates ?? []).map((rate) => (
                <SelectItem key={rate.id} value={rate.id}>
                  {rate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {taxRates.status === 'not_permitted' ? (
            <p id={taxNoteId} className="text-xs text-muted-foreground">
              {t('product_configurator.lineDetails.taxUnavailable', 'You cannot read the tax rates, so the current tax is kept.')}
            </p>
          ) : null}
          {taxRates.status === 'failed' || taxRates.status === 'loading' ? (
            <div id={taxNoteId} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="line-details-tax-failed">
              <span>{t('product_configurator.lineDetails.taxLoadFailed', 'Could not load the tax rates. The current tax is kept unless you load them again.')}</span>
              <Button type="button" variant="outline" size="sm" disabled={taxRates.status === 'loading'} onClick={() => void retryTaxRates()}>
                {t('product_configurator.configurator.retry', 'Retry')}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label id={`${contextId}-discount`}>{t('product_configurator.lineDetails.discount', 'Discount')}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={form.discountMode}
              aria-labelledby={`${contextId}-discount`}
              onValueChange={(next) => {
                if (isDiscountMode(next)) update({ discountMode: next, discountValue: next === 'none' ? '' : form.discountValue })
              }}
            >
              <SegmentedControlItem value="none">{t('product_configurator.lineDetails.discountNone', 'None')}</SegmentedControlItem>
              <SegmentedControlItem value="percent">{t('product_configurator.lineDetails.discountPercent', '%')}</SegmentedControlItem>
              <SegmentedControlItem value="amount">
                {t('product_configurator.lineDetails.discountAmount', 'Amount ({currency})', { currency: currencyCode })}
              </SegmentedControlItem>
            </SegmentedControl>
            {form.discountMode !== 'none' ? (
              <FormField className="w-40" error={discountError}>
                <Input
                  inputMode="decimal"
                  aria-label={
                    form.discountMode === 'percent'
                      ? t('product_configurator.lineDetails.discountPercentValue', 'Discount in percent')
                      : t('product_configurator.lineDetails.discountAmountValue', 'Discount amount ({currency})', { currency: currencyCode })
                  }
                  value={form.discountValue}
                  onChange={(event) => update({ discountValue: event.target.value })}
                />
              </FormField>
            ) : null}
          </div>
        </div>
        <FormField label={t('product_configurator.lineDetails.comment', 'Comment')} error={errorText(errors.comment)}>
          <Textarea value={form.comment} maxLength={COMMENT_MAX_LENGTH} rows={3} onChange={(event) => update({ comment: event.target.value })} />
        </FormField>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm" data-testid="line-details-read-only">
          <dt className="text-muted-foreground">{t('product_configurator.lineDetails.quantity', 'Quantity and unit')}</dt>
          <dd className="tabular-nums">{[new Intl.NumberFormat(locale).format(Number(line.quantity)), line.quantityUnit].filter(Boolean).join(' ')}</dd>
          <dt className="text-muted-foreground">
            {t('product_configurator.lineDetails.netPrice', 'Configured net price ({currency})', { currency: line.currencyCode ?? currencyCode })}
          </dt>
          <dd className="tabular-nums">{formatCurrency(line.unitPriceNet, line.currencyCode ?? currencyCode, locale) ?? line.unitPriceNet}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">
          {t(
            'product_configurator.lineDetails.readOnlyHint',
            'Quantity and price come from the configuration. To change them, add a changed copy with Add another identical and remove this line in Items.',
          )}
        </p>
      </div>
    )
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        data-testid="line-details-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void save()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('product_configurator.lineDetails.title', 'Edit line details')}</DialogTitle>
          <DialogDescription>
            {t('product_configurator.lineDetails.description', 'Name, comment, discount and tax of this configured line. Sales recalculates the quote totals.')}
          </DialogDescription>
        </DialogHeader>
        {renderBody()}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('product_configurator.quoteTab.picker.cancel', 'Cancel')}
          </Button>
          <Button type="button" disabled={!canSave} onClick={() => void save()} data-testid="line-details-save">
            {t('product_configurator.lineDetails.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
