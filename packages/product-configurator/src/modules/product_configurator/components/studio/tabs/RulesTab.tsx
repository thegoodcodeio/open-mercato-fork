"use client"

import * as React from 'react'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Plus } from 'lucide-react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { Tag } from '@open-mercato/ui/primitives/tag'
import type { Rule, RuleAction } from '../../../data/validators'
import { renameReference } from '../../../lib/renameReference'
import { sortByOrder } from '../../../lib/values'
import { describeCondition, describeConditions, featureValueOptions } from '../conditionRowsModel'
import { featureName, lookupName } from '../names'
import { problemCountLabel } from '../pluralLabel'
import { EFFECT_LABELS, RuleEditor } from './RuleEditor'
import { applyReferenceChanges, useReferenceChangesSince, useRevealRowEditor } from './rowEditorSession'
import { nextRuleOrder, type RuleEffect } from './ruleForm'
import { STUDIO_NEW_ROW_KEY, type StudioDefinition, type StudioTabProps } from './types'

type TranslateFn = ReturnType<typeof useT>

const EFFECT_VARIANTS: StatusMap<RuleEffect> = {
  error: 'error',
  warning: 'warning',
  force: 'info',
  surcharge: 'neutral',
}

function valueLabel(definition: StudioDefinition, featureKey: string, value: string, t: TranslateFn): string {
  const feature = definition.features.find((entry) => entry.key === featureKey)
  return featureValueOptions(definition, feature, t).find((option) => option.value === value)?.label ?? value
}

/** "Set Quick hitch (hitch) = Yes", "Map Tyres (tyres): Agricultural → Road", ... */
export function describeAction(action: RuleAction, definition: StudioDefinition, t: TranslateFn): string {
  const field = featureName(definition, action.featureKey)
  switch (action.kind) {
    case 'set':
      return t('product_configurator.studio.rules.summary.set', 'Set {field} = {value}', {
        field,
        value: valueLabel(definition, action.featureKey, String(action.value), t),
      })
    case 'map':
      return t('product_configurator.studio.rules.summary.map', 'Map {field}: {pairs}', {
        field,
        pairs: Object.entries(action.from)
          .map(([from, to]) => `${valueLabel(definition, action.featureKey, from, t)} → ${valueLabel(definition, action.featureKey, to, t)}`)
          .join(', '),
      })
    case 'lookup_default':
      return t('product_configurator.studio.rules.summary.lookupDefault', 'Default {field} from {lookup} by {keyedBy}', {
        field,
        lookup: lookupName(definition, action.lookupKey),
        keyedBy: featureName(definition, action.keyedBy),
      })
  }
}

export function RulesTab({
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
  const rules = React.useMemo(() => sortByOrder(definition.rules), [definition.rules])
  const editing = selectedKey === STUDIO_NEW_ROW_KEY ? undefined : rules.find((rule) => rule.id === selectedKey)
  const editorOpen = selectedKey === STUDIO_NEW_ROW_KEY || editing !== undefined
  const editorRef = React.useRef<HTMLDivElement>(null)
  const changesSinceOpen = useReferenceChangesSince(selectedKey, referenceChanges)

  useRevealRowEditor(editorRef, editorOpen, selectedKey)

  const removeRule = React.useCallback(
    async (rule: Rule) => {
      const confirmed = await confirm({
        title: t('product_configurator.studio.rules.deleteTitle', 'Remove {name} from the draft?', { name: rule.label ?? rule.id }),
        text: t('product_configurator.studio.rules.deleteText', 'BOM lines bound to its id will show up in Validate.'),
        variant: 'destructive',
      })
      if (!confirmed) return
      onChange((current) => ({ ...current, rules: current.rules.filter((entry) => entry.id !== rule.id) }))
      if (selectedKey === rule.id) onSelectKey(null)
    },
    [confirm, onChange, onSelectKey, selectedKey, t],
  )

  const saveRule = (saved: Rule) => {
    const originalId = editing?.id
    const [rule = saved] = applyReferenceChanges({ ...definition, rules: [saved] }, changesSinceOpen).rules
    const rename =
      originalId && originalId !== rule.id ? (current: StudioDefinition) => renameReference(current, 'rule', originalId, rule.id) : undefined
    onChange((current) => {
      const next = {
        ...current,
        rules: originalId ? current.rules.map((entry) => (entry.id === originalId ? rule : entry)) : [...current.rules, rule],
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

  const columns = React.useMemo<ColumnDef<Rule>[]>(
    () => [
      {
        id: 'rule',
        header: t('product_configurator.studio.rules.columns.rule', 'Rule'),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium text-foreground">
              {row.original.label ?? row.original.id}
              {issueCounts.has(row.original.id) ? (
                <StatusBadge variant="error">
                  {problemCountLabel(t, locale, issueCounts.get(row.original.id) ?? 0)}
                </StatusBadge>
              ) : null}
            </div>
            {row.original.label ? <div className="font-mono text-xs text-muted-foreground">{row.original.id}</div> : null}
          </div>
        ),
        meta: { truncate: false },
      },
      {
        id: 'effect',
        header: t('product_configurator.studio.rules.columns.effect', 'Effect'),
        cell: ({ row }) => (
          <StatusBadge variant={EFFECT_VARIANTS[row.original.effect]}>
            {t(EFFECT_LABELS[row.original.effect].key, EFFECT_LABELS[row.original.effect].fallback)}
          </StatusBadge>
        ),
      },
      {
        id: 'when',
        header: t('product_configurator.studio.rules.columns.when', 'When'),
        cell: ({ row }) =>
          row.original.when.length === 0 ? (
            <span className="text-muted-foreground">{describeConditions(row.original.when, definition, t)}</span>
          ) : (
            <div className="flex max-w-sm flex-wrap gap-1">
              {row.original.when.map((condition, index) => (
                <Tag key={index} shape="square">
                  {describeCondition(condition, definition, t)}
                </Tag>
              ))}
            </div>
          ),
        meta: { truncate: false },
      },
      {
        id: 'then',
        header: t('product_configurator.studio.rules.columns.then', 'Then / message'),
        cell: ({ row }) => (
          <div className="min-w-0 max-w-md space-y-1">
            {row.original.action ? <div className="font-medium text-foreground">{describeAction(row.original.action, definition, t)}</div> : null}
            {row.original.messageTemplate ? <div className="line-clamp-2 text-sm text-muted-foreground">{row.original.messageTemplate}</div> : null}
          </div>
        ),
        meta: { truncate: false },
      },
      { id: 'order', header: t('product_configurator.studio.rules.columns.order', 'Order'), cell: ({ row }) => row.original.order },
    ],
    [definition, issueCounts, locale, t],
  )

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <DataTable<Rule>
          embedded
          title={t('product_configurator.studio.rules.title', 'Rules')}
          columns={columns}
          data={rules}
          actions={
            <Button type="button" onClick={() => onSelectKey(STUDIO_NEW_ROW_KEY)} disabled={readOnly}>
              <Plus className="size-4" aria-hidden="true" />
              {t('product_configurator.studio.rules.add', 'Add rule')}
            </Button>
          }
          onRowClick={(rule) => onSelectKey(rule.id)}
          rowActions={(rule) => (
            <RowActions
              items={[
                { id: 'edit', label: t('ui.actions.edit', 'Edit'), onSelect: () => onSelectKey(rule.id) },
                ...(readOnly
                  ? []
                  : [{ id: 'delete', label: t('ui.actions.delete', 'Delete'), destructive: true, onSelect: () => void removeRule(rule) }]),
              ]}
            />
          )}
          emptyState={t('product_configurator.studio.rules.empty', 'No rules yet. Add the first one.')}
        />
      </div>
      {editorOpen ? (
        <div ref={editorRef}>
          <RuleEditor
            key={selectedKey ?? ''}
            rule={editing}
            nextOrder={nextRuleOrder(definition.rules)}
            definition={definition}
            otherIds={definition.rules.filter((rule) => rule.id !== editing?.id).map((rule) => rule.id)}
            issues={editing ? issues.filter((entry) => entry.key === editing.id) : []}
            disabled={readOnly}
            onSave={saveRule}
            onCancel={() => onSelectKey(null)}
            onDirtyChange={onDirtyChange}
          />
        </div>
      ) : null}
      {ConfirmDialogElement}
    </div>
  )
}
