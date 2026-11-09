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
import type { Formula } from '../../../data/validators'
import { formatExpression } from '../../../lib/exprFormat'
import { renameReference } from '../../../lib/renameReference'
import { problemCountLabel } from '../pluralLabel'
import { FormulaEditor } from './formulas/FormulaEditor'
import { formatPreview, previewFormulas } from './formulas/formulaForm'
import { applyReferenceChanges, useReferenceChangesSince, useRevealRowEditor } from './rowEditorSession'
import { STUDIO_NEW_ROW_KEY, type StudioDefinition, type StudioTabProps } from './types'

export function FormulasTab({
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
  const formulas = definition.formulas
  const editing = selectedKey === STUDIO_NEW_ROW_KEY ? undefined : formulas.find((formula) => formula.key === selectedKey)
  const editorOpen = selectedKey === STUDIO_NEW_ROW_KEY || editing !== undefined
  const editorRef = React.useRef<HTMLDivElement>(null)
  const changesSinceOpen = useReferenceChangesSince(selectedKey, referenceChanges)
  const previews = React.useMemo(() => previewFormulas(definition), [definition])

  useRevealRowEditor(editorRef, editorOpen, selectedKey)

  const removeFormula = React.useCallback(
    async (formula: Formula) => {
      const confirmed = await confirm({
        title: t('product_configurator.studio.formulas.deleteTitle', 'Remove {name} from the draft?', { name: formula.label ?? formula.key }),
        text: t('product_configurator.studio.formulas.deleteText', 'Rules, BOM lines and formulas that use its key will show up in Validate.'),
        variant: 'destructive',
      })
      if (!confirmed) return
      onChange((current) => ({ ...current, formulas: current.formulas.filter((entry) => entry.key !== formula.key) }))
      if (selectedKey === formula.key) onSelectKey(null)
    },
    [confirm, onChange, onSelectKey, selectedKey, t],
  )

  const saveFormula = (saved: Formula) => {
    const originalKey = editing?.key
    const [formula = saved] = applyReferenceChanges({ ...definition, formulas: [saved] }, changesSinceOpen).formulas
    const rename =
      originalKey && originalKey !== formula.key
        ? (current: StudioDefinition) => renameReference(current, 'formula', originalKey, formula.key)
        : undefined
    onChange((current) => {
      const next = {
        ...current,
        formulas: originalKey
          ? current.formulas.map((entry) => (entry.key === originalKey ? formula : entry))
          : [...current.formulas, formula],
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

  const columns = React.useMemo<ColumnDef<Formula>[]>(
    () => [
      {
        id: 'formula',
        header: t('product_configurator.studio.formulas.columns.name', 'Name'),
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
        id: 'expression',
        header: t('product_configurator.studio.formulas.columns.expression', 'Expression'),
        cell: ({ row }) => <span className="font-mono text-xs">{formatExpression(row.original.expr)}</span>,
        meta: { truncate: true, maxWidth: '28rem' },
      },
      { id: 'unit', header: t('product_configurator.studio.formulas.columns.unit', 'Unit'), cell: ({ row }) => row.original.unit ?? '' },
      {
        id: 'decimals',
        header: t('product_configurator.studio.formulas.columns.decimals', 'Decimals'),
        cell: ({ row }) => (row.original.decimals === undefined ? '' : String(row.original.decimals)),
      },
      {
        id: 'preview',
        header: t('product_configurator.studio.formulas.columns.preview', 'Preview'),
        cell: ({ row }) => (
          <span className="font-mono text-sm">
            {formatPreview(previews.get(row.original.key) ?? null, row.original.decimals, row.original.unit)}
          </span>
        ),
      },
    ],
    [issueCounts, locale, previews, t],
  )

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <DataTable<Formula>
          embedded
          title={t('product_configurator.studio.formulas.title', 'Formulas')}
          columns={columns}
          data={formulas}
          actions={
            <Button type="button" onClick={() => onSelectKey(STUDIO_NEW_ROW_KEY)} disabled={readOnly}>
              <Plus className="size-4" aria-hidden="true" />
              {t('product_configurator.studio.formulas.add', 'Add formula')}
            </Button>
          }
          onRowClick={(formula) => onSelectKey(formula.key)}
          rowActions={(formula) => (
            <RowActions
              items={[
                { id: 'edit', label: t('ui.actions.edit', 'Edit'), onSelect: () => onSelectKey(formula.key) },
                ...(readOnly
                  ? []
                  : [{ id: 'delete', label: t('ui.actions.delete', 'Delete'), destructive: true, onSelect: () => void removeFormula(formula) }]),
              ]}
            />
          )}
          emptyState={t('product_configurator.studio.formulas.empty', 'No formulas yet. Add the first one.')}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t('product_configurator.studio.formulas.previewHint', 'Previews use the model defaults. "—" means the value cannot be computed with them.')}
      </p>
      {editorOpen ? (
        <div ref={editorRef}>
          <FormulaEditor
            key={selectedKey ?? ''}
            formula={editing}
            definition={definition}
            otherKeys={formulas.filter((formula) => formula.key !== editing?.key).map((formula) => formula.key)}
            issues={editing ? issues.filter((entry) => entry.key === editing.key) : []}
            disabled={readOnly}
            onSave={saveFormula}
            onCancel={() => onSelectKey(null)}
            onDirtyChange={onDirtyChange}
          />
        </div>
      ) : null}
      {ConfirmDialogElement}
    </div>
  )
}
