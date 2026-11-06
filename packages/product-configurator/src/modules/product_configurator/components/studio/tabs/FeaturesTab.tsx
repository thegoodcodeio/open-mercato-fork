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
import type { Feature } from '../../../data/validators'
import { renameReference } from '../../../lib/renameReference'
import { sortByOrder } from '../../../lib/values'
import { describeConditions, featureValueOptions } from '../conditionRowsModel'
import { lookupName } from '../names'
import { problemCountLabel } from '../pluralLabel'
import { FeatureEditor } from './FeatureEditor'
import { applyReferenceChanges, useReferenceChangesSince } from './rowEditorSession'
import { nextFeatureOrder } from './featureForm'
import { STUDIO_NEW_ROW_KEY, type StudioDefinition, type StudioTabProps } from './types'

type TranslateFn = ReturnType<typeof useT>

const TYPE_LABEL_KEYS: Record<Feature['type'], { key: string; fallback: string }> = {
  choice: { key: 'product_configurator.studio.features.types.choice', fallback: 'Choice' },
  boolean: { key: 'product_configurator.studio.features.types.boolean', fallback: 'Yes/no' },
  number: { key: 'product_configurator.studio.features.types.number', fallback: 'Number' },
  color: { key: 'product_configurator.studio.features.types.color', fallback: 'Color' },
}

function optionsSummary(feature: Feature, definition: StudioDefinition, t: TranslateFn): string[] {
  const parts: string[] = []
  if (feature.optionsFromLookup) {
    parts.push(
      t('product_configurator.studio.features.fromLookupSummary', 'From lookup {lookup}', {
        lookup: lookupName(definition, feature.optionsFromLookup),
      }),
    )
  } else if (feature.type === 'choice' || feature.type === 'color') {
    parts.push(
      featureValueOptions(definition, feature, t)
        .map((option) => option.label)
        .join(', '),
    )
  }
  if (feature.type === 'number') {
    parts.push(
      t('product_configurator.studio.features.rangeSummary', '{min} to {max}', {
        min: feature.min === undefined ? '…' : feature.min,
        max: feature.max === undefined ? '…' : feature.max,
      }),
    )
    if (feature.step !== undefined) parts.push(t('product_configurator.studio.features.stepSummary', 'step {step}', { step: feature.step }))
  }
  if (feature.unit) parts.push(t('product_configurator.studio.features.unitSummary', 'Unit: {unit}', { unit: feature.unit }))
  return parts
}

function defaultSummary(feature: Feature, definition: StudioDefinition, t: TranslateFn): string {
  const match = featureValueOptions(definition, feature, t).find((option) => option.value === String(feature.default))
  return match ? match.label : String(feature.default)
}

export function FeaturesTab({
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
  const features = React.useMemo(() => sortByOrder(definition.features), [definition.features])
  const editing = selectedKey === STUDIO_NEW_ROW_KEY ? undefined : features.find((feature) => feature.key === selectedKey)
  const editorOpen = selectedKey === STUDIO_NEW_ROW_KEY || editing !== undefined
  const editorRef = React.useRef<HTMLDivElement>(null)
  const changesSinceOpen = useReferenceChangesSince(selectedKey, referenceChanges)

  React.useEffect(() => {
    if (editorOpen) editorRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [editorOpen, selectedKey])

  const removeFeature = React.useCallback(
    async (feature: Feature) => {
      const confirmed = await confirm({
        title: t('product_configurator.studio.features.deleteTitle', 'Remove {name} from the draft?', { name: feature.label }),
        text: t('product_configurator.studio.features.deleteText', 'Rules, formulas and lookups that use its key will show up in Validate.'),
        variant: 'destructive',
      })
      if (!confirmed) return
      onChange((current) => ({ ...current, features: current.features.filter((entry) => entry.key !== feature.key) }))
      if (selectedKey === feature.key) onSelectKey(null)
    },
    [confirm, onChange, onSelectKey, selectedKey, t],
  )

  const saveFeature = (saved: Feature) => {
    const originalKey = editing?.key
    const [feature = saved] = applyReferenceChanges({ ...definition, features: [saved] }, changesSinceOpen).features
    const rename =
      originalKey && originalKey !== feature.key
        ? (current: StudioDefinition) => renameReference(current, 'feature', originalKey, feature.key)
        : undefined
    onChange((current) => {
      const next = {
        ...current,
        features: originalKey
          ? current.features.map((entry) => (entry.key === originalKey ? feature : entry))
          : [...current.features, feature],
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

  const columns = React.useMemo<ColumnDef<Feature>[]>(
    () => [
      {
        id: 'feature',
        header: t('product_configurator.studio.features.columns.feature', 'Feature'),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium text-foreground">
              {row.original.label}
              {issueCounts.has(row.original.key) ? (
                <StatusBadge variant="error">
                  {problemCountLabel(t, locale, issueCounts.get(row.original.key) ?? 0)}
                </StatusBadge>
              ) : null}
            </div>
            <div className="font-mono text-xs text-muted-foreground">{row.original.key}</div>
          </div>
        ),
      },
      {
        id: 'type',
        header: t('product_configurator.studio.features.columns.type', 'Type'),
        cell: ({ row }) => t(TYPE_LABEL_KEYS[row.original.type].key, TYPE_LABEL_KEYS[row.original.type].fallback),
      },
      {
        id: 'options',
        header: t('product_configurator.studio.features.columns.options', 'Options or range'),
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-x-2">
            {optionsSummary(row.original, definition, t).map((part) => (
              <span key={part}>{part}</span>
            ))}
          </span>
        ),
        meta: { truncate: true, maxWidth: '18rem' },
      },
      { id: 'group', header: t('product_configurator.studio.features.columns.group', 'Group'), cell: ({ row }) => row.original.group ?? '' },
      {
        id: 'default',
        header: t('product_configurator.studio.features.columns.default', 'Default'),
        cell: ({ row }) => defaultSummary(row.original, definition, t),
      },
      {
        id: 'inSummary',
        header: t('product_configurator.studio.features.columns.inSummary', 'In summary'),
        cell: ({ row }) =>
          row.original.inSummary ? t('product_configurator.studio.conditions.yes', 'Yes') : t('product_configurator.studio.conditions.no', 'No'),
      },
      {
        id: 'visibleWhen',
        header: t('product_configurator.studio.features.columns.visibleWhen', 'Shown when'),
        cell: ({ row }) => describeConditions(row.original.visibleWhen, definition, t),
        meta: { truncate: true, maxWidth: '18rem' },
      },
    ],
    [definition, issueCounts, locale, t],
  )

  return (
    <div className="space-y-4">
      <DataTable<Feature>
        embedded
        title={t('product_configurator.studio.features.title', 'Features')}
        columns={columns}
        data={features}
        actions={
          <Button type="button" onClick={() => onSelectKey(STUDIO_NEW_ROW_KEY)} disabled={readOnly}>
            <Plus className="size-4" aria-hidden="true" />
            {t('product_configurator.studio.features.add', 'Add feature')}
          </Button>
        }
        onRowClick={(feature) => onSelectKey(feature.key)}
        rowActions={(feature) => (
          <RowActions
            items={[
              { id: 'edit', label: t('ui.actions.edit', 'Edit'), onSelect: () => onSelectKey(feature.key) },
              ...(readOnly
                ? []
                : [{ id: 'delete', label: t('ui.actions.delete', 'Delete'), destructive: true, onSelect: () => void removeFeature(feature) }]),
            ]}
          />
        )}
        emptyState={t('product_configurator.studio.features.empty', 'No features yet. Add the first one.')}
      />
      {editorOpen ? (
        <div ref={editorRef}>
          <FeatureEditor
            key={selectedKey ?? ''}
            feature={editing}
            nextOrder={nextFeatureOrder(definition.features)}
            definition={definition}
            otherKeys={definition.features.filter((feature) => feature.key !== editing?.key).map((feature) => feature.key)}
            issues={editing ? issues.filter((entry) => entry.key === editing.key) : []}
            disabled={readOnly}
            onSave={saveFeature}
            onCancel={() => onSelectKey(null)}
            onDirtyChange={onDirtyChange}
          />
        </div>
      ) : null}
      {ConfirmDialogElement}
    </div>
  )
}
