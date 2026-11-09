"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { CatalogEntry } from './bomCatalog'

type BomUnitFieldProps = {
  /** The unit, or why there is none ("Checking the catalog…", "no common unit", "—"). */
  unitText: string
  /** Catalog answer for a fixed SKU, for the "base unit of" hint. */
  skuEntry: CatalogEntry | undefined
  problems: readonly string[]
  /** "SKU: unit" list shown with the problems when the SKUs of a lookup use different units. */
  unitList: string | null
  error: string | undefined
}

/** The read-only catalog unit of the line and the reasons it cannot be used. */
export function BomUnitField({ unitText, skuEntry, problems, unitList, error }: BomUnitFieldProps) {
  const t = useT()
  return (
    <div className="min-w-0 space-y-1" data-testid="bom-unit">
      <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.bom.unit.label', 'Unit (from catalog, read-only)')}</p>
      <p className="flex h-9 items-center font-mono text-sm text-foreground" aria-live="polite">
        {unitText}
      </p>
      {skuEntry?.status === 'found' && skuEntry.unit ? (
        <p className="text-xs text-muted-foreground">
          {t('product_configurator.studio.bom.unit.catalogHint', 'Base unit of {title} in the catalog.', { title: skuEntry.title })}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <div className="space-y-1" role="alert">
          {problems.map((problem) => (
            <p key={problem} className="text-xs text-status-error-text">
              {problem}
            </p>
          ))}
          {unitList ? <p className="font-mono text-xs text-muted-foreground">{unitList}</p> : null}
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-status-error-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
