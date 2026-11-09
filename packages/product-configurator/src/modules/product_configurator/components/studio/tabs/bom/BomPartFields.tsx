"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Input } from '@open-mercato/ui/primitives/input'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { featureName, friendlyName } from '../../names'
import type { StudioDefinition } from '../types'
import type { CatalogEntry } from './bomCatalog'
import { skuLookups, type BomFormValues, type BomPartKind } from './bomForm'
import { KeySelect } from '../../KeySelect'

const PART_KINDS: readonly BomPartKind[] = ['sku', 'lookup']

type BomPartFieldsProps = {
  values: BomFormValues
  onChange: (patch: Partial<BomFormValues>) => void
  definition: StudioDefinition
  /** Catalog answer for the typed SKU, once checked. */
  skuEntry: CatalogEntry | undefined
  error: (field: string) => string | undefined
  fieldId: (name: string) => string
  disabled: boolean
}

/** What the line adds: a fixed SKU checked against the catalog, or the SKU a value lookup gives. */
export function BomPartFields({ values, onChange, definition, skuEntry, error, fieldId, disabled }: BomPartFieldsProps) {
  const t = useT()
  const lookups = skuLookups(definition)
  const lookup = lookups.find((entry) => entry.key === values.lookupKey)

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.bom.part', 'Part')}</p>
        <SegmentedControl
          value={values.partKind}
          disabled={disabled}
          aria-label={t('product_configurator.studio.bom.part', 'Part')}
          onValueChange={(next) => {
            const partKind = PART_KINDS.find((entry) => entry === next)
            if (partKind) onChange({ partKind })
          }}
        >
          <SegmentedControlItem value="sku">{t('product_configurator.studio.bom.partKinds.sku', 'Fixed SKU')}</SegmentedControlItem>
          <SegmentedControlItem value="lookup">{t('product_configurator.studio.bom.partKinds.lookup', 'SKU from lookup')}</SegmentedControlItem>
        </SegmentedControl>
      </div>
      {values.partKind === 'sku' ? (
        <div className="min-w-0 space-y-1">
          <FormField id={fieldId('sku')} label={t('product_configurator.studio.bom.sku', 'SKU')} error={error('sku')}>
            <Input className="font-mono" value={values.sku} disabled={disabled} onChange={(event) => onChange({ sku: event.target.value })} />
          </FormField>
          <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
            {skuEntry?.status === 'found' ? (
              <span className="text-foreground" data-testid="bom-sku-title">
                {skuEntry.title}
              </span>
            ) : null}
            {skuEntry?.status === 'unknown' ? (
              <StatusBadge variant="error">{t('product_configurator.studio.bom.unknownSku', 'Unknown SKU')}</StatusBadge>
            ) : null}
            {skuEntry?.status === 'ambiguous' ? (
              <StatusBadge variant="error">{t('product_configurator.studio.bom.ambiguousSku', 'Ambiguous SKU')}</StatusBadge>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <FormField
            id={fieldId('lookup')}
            className="min-w-0"
            label={t('product_configurator.studio.bom.lookup', 'Value lookup with SKUs')}
            error={error('lookupKey')}
          >
            <KeySelect
              value={values.lookupKey}
              options={lookups.map((entry) => ({ value: entry.key, label: friendlyName(entry.label, entry.key) }))}
              placeholder={t('product_configurator.studio.bom.pickLookup', 'Pick a lookup')}
              disabled={disabled}
              onChange={(lookupKey) => onChange({ lookupKey })}
            />
          </FormField>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">{t('product_configurator.studio.bom.keyedBy', 'Keyed by')}</p>
            <p className="flex h-9 items-center text-sm text-muted-foreground" data-testid="bom-keyed-by">
              {lookup ? featureName(definition, lookup.keyedBy) : '—'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
