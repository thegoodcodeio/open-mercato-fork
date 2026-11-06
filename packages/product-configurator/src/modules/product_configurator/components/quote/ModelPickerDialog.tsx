"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { Radio, RadioGroup } from '@open-mercato/ui/primitives/radio'
import type { ModelCandidate } from './quoteTabApi'

type ModelPickerDialogProps = {
  open: boolean
  candidates: ModelCandidate[]
  currencyCode: string
  busy: boolean
  onCancel: () => void
  onStart: (modelId: string) => void
}

/** Shown only when several models fit the quote. Escape cancels, Cmd/Ctrl+Enter starts. */
export function ModelPickerDialog({ open, candidates, currencyCode, busy, onCancel, onStart }: ModelPickerDialogProps) {
  const t = useT()
  const [selected, setSelected] = React.useState<string>('')
  const radioId = React.useId()

  React.useEffect(() => {
    if (open) setSelected(candidates[0]?.id ?? '')
  }, [open, candidates])

  const start = () => {
    if (selected && !busy) onStart(selected)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        data-testid="quote-configure-model-picker"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            start()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('product_configurator.quoteTab.picker.title', 'Choose a model')}</DialogTitle>
          <DialogDescription>
            {t('product_configurator.quoteTab.picker.description', 'Models with a published version in the quote currency ({currency}).', {
              currency: currencyCode,
            })}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={selected} onValueChange={setSelected} aria-label={t('product_configurator.quoteTab.picker.title', 'Choose a model')}>
          {candidates.map((candidate) => (
            <label key={candidate.id} htmlFor={`${radioId}-${candidate.id}`} className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3">
              <Radio id={`${radioId}-${candidate.id}`} value={candidate.id} />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{candidate.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('product_configurator.configurator.header.version', 'Model v{version}', { version: candidate.latestVersion?.version ?? '' })}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('product_configurator.quoteTab.picker.cancel', 'Cancel')}
          </Button>
          <Button type="button" disabled={!selected || busy} onClick={start}>
            {t('product_configurator.quoteTab.picker.start', 'Start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
