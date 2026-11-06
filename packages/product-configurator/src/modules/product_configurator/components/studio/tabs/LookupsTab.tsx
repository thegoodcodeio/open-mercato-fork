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
import type { Lookup } from '../../../data/validators'
import { renameReference } from '../../../lib/renameReference'
import { syncLookupKeyedBy } from '../../../lib/syncLookupKeyedBy'
import { featureName, friendlyName } from '../names'
import { problemCountLabel } from '../pluralLabel'
import { LookupEditor } from './lookups/LookupEditor'
import { keyDomain, missingMatches } from './lookups/lookupForm'
import { applyReferenceChanges, useReferenceChangesSince } from './rowEditorSession'
import { STUDIO_NEW_ROW_KEY, type StudioDefinition, type StudioTabProps } from './types'

const KIND_LABELS: Record<Lookup['kind'], { key: string; fallback: string }> = {
  value: { key: 'product_configurator.studio.lookups.kinds.value', fallback: 'Value' },
  permitted: { key: 'product_configurator.studio.lookups.kinds.permitted', fallback: 'Permitted options' },
}

export function LookupsTab({
  definition,
  onChange,
  readOnly,
  issues,
  selectedKey,
  onSelectKey,
  onNavigate,
  referenceChanges,
  onDirtyChange,
}: StudioTabProps) {
  const t = useT()
  const locale = useLocale()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const lookups = definition.lookups
  const editing = selectedKey === STUDIO_NEW_ROW_KEY ? undefined : lookups.find((lookup) => lookup.key === selectedKey)
  const editorOpen = selectedKey === STUDIO_NEW_ROW_KEY || editing !== undefined
  const editorRef = React.useRef<HTMLDivElement>(null)
  const changesSinceOpen = useReferenceChangesSince(selectedKey, referenceChanges)

  React.useEffect(() => {
    if (editorOpen) editorRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [editorOpen, selectedKey])

  const removeLookup = React.useCallback(
    async (lookup: Lookup) => {
      const confirmed = await confirm({
        title: t('product_configurator.studio.lookups.deleteTitle', 'Remove {name} from the draft?', { name: friendlyName(lookup.label, lookup.key) }),
        text: t('product_configurator.studio.lookups.deleteText', 'Features, formulas, rules and BOM lines that use its key will show up in Validate.'),
        variant: 'destructive',
      })
      if (!confirmed) return
      onChange((current) => ({ ...current, lookups: current.lookups.filter((entry) => entry.key !== lookup.key) }))
      if (selectedKey === lookup.key) onSelectKey(null)
    },
    [confirm, onChange, onSelectKey, selectedKey, t],
  )

  const saveLookup = (saved: Lookup) => {
    const original = editing
    const originalKey = original?.key
    const [lookup = saved] = applyReferenceChanges({ ...definition, lookups: [saved] }, changesSinceOpen).lookups
    const renamed = original !== undefined && original.key !== lookup.key
    const rekeyed = original !== undefined && original.keyedBy !== lookup.keyedBy
    const referenceChange =
      original && (renamed || rekeyed)
        ? (current: StudioDefinition) => {
            const next = renamed ? renameReference(current, 'lookup', original.key, lookup.key) : current
            return rekeyed ? syncLookupKeyedBy(next, lookup.key, lookup.keyedBy) : next
          }
        : undefined
    onChange((current) => {
      const next = {
        ...current,
        lookups: originalKey ? current.lookups.map((entry) => (entry.key === originalKey ? lookup : entry)) : [...current.lookups, lookup],
      }
      return referenceChange ? referenceChange(next) : next
    }, referenceChange)
    onSelectKey(null)
  }

  const issueCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of issues) if (entry.key) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
    return counts
  }, [issues])

  const missingCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const lookup of lookups) {
      const matches = lookup.rows.map((row) => row.match)
      counts.set(lookup.key, missingMatches(keyDomain(definition, lookup.keyedBy, t), matches).length)
    }
    return counts
  }, [definition, lookups, t])

  const columns = React.useMemo<ColumnDef<Lookup>[]>(
    () => [
      {
        id: 'lookup',
        header: t('product_configurator.studio.lookups.columns.lookup', 'Lookup'),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium text-foreground">
              {row.original.label ?? row.original.key}
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
        id: 'kind',
        header: t('product_configurator.studio.lookups.columns.kind', 'Type'),
        cell: ({ row }) => t(KIND_LABELS[row.original.kind].key, KIND_LABELS[row.original.kind].fallback),
      },
      {
        id: 'keyedBy',
        header: t('product_configurator.studio.lookups.columns.keyedBy', 'Keyed by'),
        cell: ({ row }) => featureName(definition, row.original.keyedBy),
      },
      {
        id: 'rows',
        header: t('product_configurator.studio.lookups.columns.rows', 'Rows'),
        cell: ({ row }) => {
          const missing = missingCounts.get(row.original.key) ?? 0
          return (
            <div className="flex items-center gap-2">
              <span className="tabular-nums">{row.original.rows.length}</span>
              {missing > 0 ? (
                <StatusBadge variant="warning">
                  {t('product_configurator.studio.lookups.missingRows', 'Options without a row: {count}', { count: missing })}
                </StatusBadge>
              ) : null}
            </div>
          )
        },
      },
    ],
    [definition, issueCounts, locale, missingCounts, t],
  )

  return (
    <div className="space-y-4">
      <DataTable<Lookup>
        embedded
        title={t('product_configurator.studio.lookups.title', 'Lookups')}
        columns={columns}
        data={lookups}
        actions={
          <Button type="button" onClick={() => onSelectKey(STUDIO_NEW_ROW_KEY)} disabled={readOnly}>
            <Plus className="size-4" aria-hidden="true" />
            {t('product_configurator.studio.lookups.add', 'Add lookup')}
          </Button>
        }
        onRowClick={(lookup) => onSelectKey(lookup.key)}
        rowActions={(lookup) => (
          <RowActions
            items={[
              { id: 'edit', label: t('ui.actions.edit', 'Edit'), onSelect: () => onSelectKey(lookup.key) },
              ...(readOnly
                ? []
                : [{ id: 'delete', label: t('ui.actions.delete', 'Delete'), destructive: true, onSelect: () => void removeLookup(lookup) }]),
            ]}
          />
        )}
        emptyState={t('product_configurator.studio.lookups.empty', 'No lookups yet. Add one to map a choice to a value, a SKU or a list of allowed options.')}
      />
      {editorOpen ? (
        <div ref={editorRef}>
          <LookupEditor
            key={selectedKey ?? ''}
            lookup={editing}
            definition={definition}
            otherKeys={lookups.filter((lookup) => lookup.key !== editing?.key).map((lookup) => lookup.key)}
            issues={editing ? issues.filter((entry) => entry.key === editing.key) : []}
            disabled={readOnly}
            onSave={saveLookup}
            onCancel={() => onSelectKey(null)}
            onOpenAdvanced={() => onNavigate('advanced')}
            onDirtyChange={onDirtyChange}
          />
        </div>
      ) : null}
      {ConfirmDialogElement}
    </div>
  )
}
