"use client"

import * as React from 'react'
import { Plus } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { sortByOrder } from '../../../lib/values'
import { friendlyName } from '../names'
import { KeySelect } from '../KeySelect'
import { insertToken } from './ruleForm'
import type { StudioDefinition } from './types'

type RuleMessageEditorProps = {
  value: string
  definition: StudioDefinition
  /** BOM lines whose `{line.<bomId>.total}` this rule may show (surcharge rules bound to the line). */
  lineIds: readonly string[]
  /** True for a surcharge rule, so the editor can explain how to get a line total. */
  surcharge: boolean
  disabled: boolean
  onChange: (value: string) => void
}

/** Plain-text message the rep sees, with helpers that insert `{feature.x}`, `{formula.x}`, `{lookup.x}` and `{line.<bomId>.total}` at the caret. */
export function RuleMessageEditor({ value, definition, lineIds, surcharge, disabled, onChange }: RuleMessageEditorProps) {
  const t = useT()
  // Where the admin last left the caret; a placeholder picked before they touched the text goes at the end.
  const selectionRef = React.useRef<{ start: number; end: number } | null>(null)
  const rememberSelection = (element: HTMLTextAreaElement) => {
    selectionRef.current = { start: element.selectionStart, end: element.selectionEnd }
  }

  const insert = (token: string) => {
    const selection = selectionRef.current
    const next = insertToken(value, token, selection?.start ?? null, selection?.end ?? null)
    selectionRef.current = { start: next.caret, end: next.caret }
    onChange(next.text)
  }

  const inserters = [
    {
      kind: 'feature',
      label: t('product_configurator.studio.rules.message.insertFeature', 'Feature'),
      options: sortByOrder(definition.features).map((feature) => ({ value: feature.key, label: friendlyName(feature.label, feature.key) })),
    },
    {
      kind: 'formula',
      label: t('product_configurator.studio.rules.message.insertFormula', 'Formula'),
      options: definition.formulas.map((formula) => ({ value: formula.key, label: friendlyName(formula.label, formula.key) })),
    },
    {
      kind: 'lookup',
      label: t('product_configurator.studio.rules.message.insertLookup', 'Lookup'),
      options: definition.lookups.map((lookup) => ({ value: lookup.key, label: friendlyName(lookup.label, lookup.key) })),
    },
  ]

  return (
    <div className="space-y-2" data-testid="rule-message-editor">
      <FormField
        label={t('product_configurator.studio.rules.message.label', 'Message')}
        description={t('product_configurator.studio.rules.message.hint', 'Plain text the rep sees, never the rule id. Placeholders are replaced with the current values.')}
      >
        <Textarea
          value={value}
          rows={3}
          disabled={disabled}
          onSelect={(event) => rememberSelection(event.currentTarget)}
          onChange={(event) => {
            rememberSelection(event.currentTarget)
            onChange(event.target.value)
          }}
        />
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t('product_configurator.studio.rules.message.insert', 'Insert:')}</span>
        {inserters.map((inserter) => (
          <KeySelect
            key={inserter.kind}
            size="sm"
            value=""
            options={inserter.options}
            disabled={disabled || inserter.options.length === 0}
            className="w-40"
            placeholder={inserter.label}
            ariaLabel={t('product_configurator.studio.rules.message.insertAria', 'Insert a {kind} placeholder', { kind: inserter.label })}
            onChange={(key) => insert(`{${inserter.kind}.${key}}`)}
          />
        ))}
        {lineIds.map((lineId) => (
          <Button key={lineId} type="button" variant="outline" size="sm" disabled={disabled} onClick={() => insert(`{line.${lineId}.total}`)}>
            <Plus className="size-4" aria-hidden="true" />
            {t('product_configurator.studio.rules.message.insertLine', 'Line total: {line}', { line: lineId })}
          </Button>
        ))}
      </div>
      {surcharge && lineIds.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('product_configurator.studio.rules.message.noBoundLine', 'Bind a BOM line to this rule in the BOM tab to show its total here.')}
        </p>
      ) : null}
    </div>
  )
}
