"use client"

import * as React from 'react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import type { ConfigurationDefinition } from '../../../data/validators'
import { formatSelectionValue } from '../workspaceModel'
import { changedChoices } from './sessionApi'
import type { SessionConflict } from './useSessionWorkspace'

type SessionChangedPanelProps = {
  definition: ConfigurationDefinition
  conflict: SessionConflict
  onResolve: (choice: 'keep' | 'apply') => void
}

/** `session_changed`: the rep's refused choices next to the current ones, to keep the current state or apply them again. */
export function SessionChangedPanel({ definition, conflict, onResolve }: SessionChangedPanelProps) {
  const t = useT()
  const locale = useLocale()
  const panelRef = React.useRef<HTMLDivElement>(null)
  const rows = changedChoices(definition, conflict)

  React.useEffect(() => {
    panelRef.current?.focus()
  }, [conflict])

  const display = (featureKey: string, value: string | number | boolean | null) => {
    if (value === null) return '-'
    const text = formatSelectionValue(definition, featureKey, value, locale, t)
    const unit = definition.features.find((feature) => feature.key === featureKey)?.unit
    return typeof value === 'number' && unit ? `${text} ${unit}` : text
  }

  return (
    <div ref={panelRef} tabIndex={-1} className="outline-none" data-testid="configurator-session-changed">
      <Alert status="warning">
        <AlertTitle>{t('product_configurator.configurator.sessionChanged.title', 'Changed in another window')}</AlertTitle>
        <AlertDescription>
          <p>
            {t(
              'product_configurator.configurator.sessionChanged.text',
              'This configuration was changed in another window or by a colleague. Your choices were not applied.',
            )}
          </p>
          {rows.length ? (
            <Table className="mt-2">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('product_configurator.configurator.sessionChanged.field', 'Field')}</TableHead>
                  <TableHead>{t('product_configurator.configurator.sessionChanged.yours', 'Yours')}</TableHead>
                  <TableHead>{t('product_configurator.configurator.sessionChanged.current', 'Current')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.featureKey}>
                    <TableCell>{row.label}</TableCell>
                    <TableCell>{display(row.featureKey, row.yours)}</TableCell>
                    <TableCell>{display(row.featureKey, row.current)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onResolve('keep')}>
              {t('product_configurator.configurator.sessionChanged.keep', 'Keep current')}
            </Button>
            <Button type="button" size="sm" onClick={() => onResolve('apply')}>
              {t('product_configurator.configurator.sessionChanged.apply', 'Apply my choices')}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  )
}
