"use client"

import * as React from 'react'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Plus } from 'lucide-react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import type { BomLineDefinition } from '../../../data/validators'
import { renameReference } from '../../../lib/renameReference'
import { sortByOrder } from '../../../lib/values'
import { describeConditions } from '../conditionRowsModel'
import { featureName, formulaName } from '../names'
import { problemCountLabel } from '../pluralLabel'
import { summarizeSkuUnits, useCatalogItems, type CatalogCache, type CatalogEntry } from './bom/bomCatalog'
import { definitionLineSkus, nextBomOrder, suggestBomId } from './bom/bomForm'
import { BomLineEditor } from './bom/BomLineEditor'
import { unitList } from './bom/bomUnitMessages'
import { applyReferenceChanges, useReferenceChangesSince, useRevealRowEditor } from './rowEditorSession'
import { STUDIO_NEW_ROW_KEY, type StudioDefinition, type StudioTabProps } from './types'

type TranslateFn = ReturnType<typeof useT>

function PartCell({ line, definition, entry, problemCount, locale, t }: {
  line: BomLineDefinition
  definition: StudioDefinition
  entry: CatalogEntry | undefined
  problemCount: number
  locale: string
  t: TranslateFn
}) {
  const badge =
    problemCount > 0 ? (
      <StatusBadge variant="error">{problemCountLabel(t, locale, problemCount)}</StatusBadge>
    ) : null
  if (line.skuFromLookup) {
    const { lookupKey, keyedBy } = line.skuFromLookup
    const lookup = definition.lookups.find((candidate) => candidate.key === lookupKey)
    return (
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
          {lookup?.label ?? line.id}
          {badge}
        </div>
        <div className="text-xs text-muted-foreground">
          {t('product_configurator.studio.bom.fromLookupSummary', 'SKU from lookup {lookup}, by {feature}', {
            lookup: lookupKey,
            feature: featureName(definition, keyedBy),
          })}
        </div>
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
        {entry?.status === 'found' ? entry.title : line.sku}
        {entry?.status === 'unknown' ? (
          <StatusBadge variant="error">{t('product_configurator.studio.bom.unknownSku', 'Unknown SKU')}</StatusBadge>
        ) : null}
        {entry?.status === 'ambiguous' ? (
          <StatusBadge variant="error">{t('product_configurator.studio.bom.ambiguousSku', 'Ambiguous SKU')}</StatusBadge>
        ) : null}
        {badge}
      </div>
      <div className="font-mono text-xs text-muted-foreground">{line.sku}</div>
    </div>
  )
}

function UnitCell({ line, definition, entries, t }: {
  line: BomLineDefinition
  definition: StudioDefinition
  entries: ReadonlyMap<string, CatalogEntry>
  t: TranslateFn
}) {
  const summary = summarizeSkuUnits(definitionLineSkus(line, definition), entries)
  const fromLookup = line.skuFromLookup !== undefined
  const settled = !summary.checking && !summary.unavailable
  if (fromLookup && settled && summary.units.length > 0 && summary.missingUnit.length === 0 && !summary.commonUnit) {
    return (
      <div className="min-w-0">
        <div className="text-status-error-text">{t('product_configurator.studio.bom.unit.noCommon', 'no common unit')}</div>
        <div className="font-mono text-xs text-muted-foreground">{unitList(summary)}</div>
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <span className="font-mono">{line.uom}</span>
      {summary.commonUnit === line.uom ? (
        <span className="ml-2 text-xs text-muted-foreground">
          {fromLookup ? t('product_configurator.studio.bom.unit.common', 'common') : t('product_configurator.studio.bom.unit.catalog', 'catalog')}
        </span>
      ) : null}
      {summary.commonUnit !== null && summary.commonUnit !== line.uom ? (
        <div className="text-xs text-status-error-text">
          {t('product_configurator.studio.bom.unit.differs', 'Catalog unit: {unit}', { unit: summary.commonUnit })}
        </div>
      ) : null}
      {settled && summary.missingUnit.length > 0 ? (
        <div className="text-xs text-status-error-text">
          {t('product_configurator.studio.bom.unit.missing', 'No base unit in the catalog: {skus}', { skus: summary.missingUnit.join(', ') })}
        </div>
      ) : null}
    </div>
  )
}

export function BomTab({
  definition,
  onChange,
  readOnly,
  issues,
  selectedKey,
  onSelectKey,
  referenceChanges,
  onDirtyChange,
}: StudioTabProps) {
  const t = useT()
  const locale = useLocale()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [catalogCache] = React.useState<CatalogCache>(() => new Map())
  const lines = React.useMemo(() => sortByOrder(definition.bom), [definition.bom])
  const editing = selectedKey === STUDIO_NEW_ROW_KEY ? undefined : lines.find((line) => line.id === selectedKey)
  const editorOpen = selectedKey === STUDIO_NEW_ROW_KEY || editing !== undefined
  const editorRef = React.useRef<HTMLDivElement>(null)
  const changesSinceOpen = useReferenceChangesSince(selectedKey, referenceChanges)
  const tableSkus = React.useMemo(() => lines.flatMap((line) => definitionLineSkus(line, definition)), [definition, lines])
  const catalog = useCatalogItems(tableSkus, catalogCache)

  useRevealRowEditor(editorRef, editorOpen, selectedKey)

  const removeLine = React.useCallback(
    async (line: BomLineDefinition) => {
      const confirmed = await confirm({
        title: t('product_configurator.studio.bom.deleteTitle', 'Remove line {name} from the draft?', { name: line.id }),
        text: t('product_configurator.studio.bom.deleteText', 'Rules that use this line in a message will show up in Validate.'),
        variant: 'destructive',
      })
      if (!confirmed) return
      onChange((current) => ({ ...current, bom: current.bom.filter((entry) => entry.id !== line.id) }))
      if (selectedKey === line.id) onSelectKey(null)
    },
    [confirm, onChange, onSelectKey, selectedKey, t],
  )

  const saveLine = (saved: BomLineDefinition) => {
    const originalId = editing?.id
    const [line = saved] = applyReferenceChanges({ ...definition, bom: [saved] }, changesSinceOpen).bom
    const rename =
      originalId && originalId !== line.id ? (current: StudioDefinition) => renameReference(current, 'bom', originalId, line.id) : undefined
    onChange((current) => {
      const next = {
        ...current,
        bom: originalId ? current.bom.map((entry) => (entry.id === originalId ? line : entry)) : [...current.bom, line],
      }
      return rename ? rename(next) : next
    }, rename)
    onSelectKey(null)
  }

  const issueCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of issues) if (entry.key) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
    return counts
  }, [issues])

  const columns = React.useMemo<ColumnDef<BomLineDefinition>[]>(
    () => [
      {
        id: 'part',
        header: t('product_configurator.studio.bom.columns.part', 'Part'),
        cell: ({ row }) => (
          <PartCell
            line={row.original}
            definition={definition}
            entry={row.original.sku ? catalog.entries.get(row.original.sku) : undefined}
            problemCount={issueCounts.get(row.original.id) ?? 0}
            locale={locale}
            t={t}
          />
        ),
      },
      {
        id: 'quantity',
        header: t('product_configurator.studio.bom.columns.quantity', 'Quantity'),
        cell: ({ row }) =>
          typeof row.original.quantity === 'number' ? String(row.original.quantity) : formulaName(definition, row.original.quantity.formulaKey),
      },
      {
        id: 'unit',
        header: t('product_configurator.studio.bom.columns.unit', 'Unit'),
        cell: ({ row }) => <UnitCell line={row.original} definition={definition} entries={catalog.entries} t={t} />,
      },
      {
        id: 'when',
        header: t('product_configurator.studio.bom.columns.when', 'Included when'),
        cell: ({ row }) => describeConditions(row.original.when, definition, t),
        meta: { truncate: true, maxWidth: '18rem' },
      },
      {
        id: 'rule',
        header: t('product_configurator.studio.bom.columns.rule', 'Surcharge rule'),
        cell: ({ row }) => {
          const ruleId = row.original.ruleId
          if (!ruleId) return '—'
          const label = definition.rules.find((rule) => rule.id === ruleId)?.label
          return (
            <div className="min-w-0">
              {label ? <div className="text-foreground">{label}</div> : null}
              <div className="font-mono text-xs text-muted-foreground">{ruleId}</div>
            </div>
          )
        },
      },
      { id: 'order', header: t('product_configurator.studio.bom.columns.order', 'Order'), cell: ({ row }) => String(row.original.order) },
    ],
    [catalog.entries, definition, issueCounts, locale, t],
  )

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <DataTable<BomLineDefinition>
          embedded
          title={t('product_configurator.studio.bom.title', 'Bill of materials')}
          columns={columns}
          data={lines}
          actions={
            <Button type="button" onClick={() => onSelectKey(STUDIO_NEW_ROW_KEY)} disabled={readOnly}>
              <Plus className="size-4" aria-hidden="true" />
              {t('product_configurator.studio.bom.add', 'Add line')}
            </Button>
          }
          onRowClick={(line) => onSelectKey(line.id)}
          rowActions={(line) => (
            <RowActions
              items={[
                { id: 'edit', label: t('ui.actions.edit', 'Edit'), onSelect: () => onSelectKey(line.id) },
                ...(readOnly
                  ? []
                  : [{ id: 'delete', label: t('ui.actions.delete', 'Delete'), destructive: true, onSelect: () => void removeLine(line) }]),
              ]}
            />
          )}
          emptyState={t('product_configurator.studio.bom.empty', 'No parts yet. Add the first line.')}
        />
      </div>
      {editorOpen ? (
        <div ref={editorRef}>
          <BomLineEditor
            key={selectedKey ?? ''}
            line={editing}
            defaults={{ id: suggestBomId(definition.bom), order: nextBomOrder(definition.bom) }}
            definition={definition}
            otherIds={definition.bom.filter((line) => line.id !== editing?.id).map((line) => line.id)}
            catalogCache={catalogCache}
            issues={editing ? issues.filter((entry) => entry.key === editing.id) : []}
            disabled={readOnly}
            onSave={saveLine}
            onCancel={() => onSelectKey(null)}
            onDirtyChange={onDirtyChange}
          />
        </div>
      ) : null}
      {ConfirmDialogElement}
    </div>
  )
}
