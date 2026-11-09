"use client"

import * as React from 'react'
import { Copy } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'

type ConflictRefreshDialogProps = {
  open: boolean
  busy: boolean
  onCopyDraft: () => void
  onCancel: () => void
  onRefresh: () => void
}

/** Asked before a conflict refresh replaces unsaved edits; offers a JSON copy of the local draft first. */
export function ConflictRefreshDialog({ open, busy, onCopyDraft, onCancel, onRefresh }: ConflictRefreshDialogProps) {
  const t = useT()
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (!busy) onRefresh()
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent onKeyDown={handleKeyDown} data-testid="studio-conflict-refresh-dialog">
        <DialogHeader>
          <DialogTitle>{t('product_configurator.studio.conflict.refreshTitle', 'Refresh and lose your changes?')}</DialogTitle>
          <DialogDescription>
            {t(
              'product_configurator.studio.conflict.refreshText',
              'Your unsaved edits will be replaced by the saved version. Copy your draft first if you need it.',
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCopyDraft}>
            <Copy className="mr-2 size-4" aria-hidden="true" />
            {t('product_configurator.studio.conflict.copyDraft', 'Copy my draft (JSON)')}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('ui.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive-solid" onClick={onRefresh} disabled={busy}>
            {t('product_configurator.studio.conflict.refresh', 'Refresh')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
