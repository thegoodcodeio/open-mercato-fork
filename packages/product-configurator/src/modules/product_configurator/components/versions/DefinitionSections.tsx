"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CollapsibleSection } from '@open-mercato/ui/backend/SectionHeader'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import type { ConfigurationDefinition, Feature, Lookup, Rule } from '../../data/validators'
import { formatExpression } from '../../lib/exprFormat'
import { sortByOrder } from '../../lib/values'
import {
  formatAction,
  formatBomQuantity,
  formatBomSku,
  formatConditions,
  formatFeatureValues,
  formatValue,
} from './definitionText'

const FEATURE_TYPE_LABELS: Record<Feature['type'], { key: string; fallback: string }> = {
  choice: { key: 'product_configurator.versions.featureTypes.choice', fallback: 'Choice' },
  boolean: { key: 'product_configurator.versions.featureTypes.boolean', fallback: 'Yes/no' },
  number: { key: 'product_configurator.versions.featureTypes.number', fallback: 'Number' },
  color: { key: 'product_configurator.versions.featureTypes.color', fallback: 'Color' },
}

const RULE_EFFECT_LABELS: Record<Rule['effect'], { key: string; fallback: string }> = {
  error: { key: 'product_configurator.versions.effects.error', fallback: 'Blocks' },
  warning: { key: 'product_configurator.versions.effects.warning', fallback: 'Warning' },
  force: { key: 'product_configurator.versions.effects.force', fallback: 'Sets a value' },
  surcharge: { key: 'product_configurator.versions.effects.surcharge', fallback: 'Surcharge' },
}

type ReadOnlyTableProps = {
  headers: string[]
  rows: Array<{ key: string; cells: React.ReactNode[] }>
}

function EmptyNote() {
  const t = useT()
  return <p className="text-sm text-muted-foreground">{t('product_configurator.versions.empty', 'Nothing defined.')}</p>
}

function ReadOnlyTable({ headers, rows }: ReadOnlyTableProps) {
  if (rows.length === 0) return <EmptyNote />
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((header) => (
              <TableHead key={header}>{header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              {row.cells.map((cell, index) => (
                <TableCell key={index} className="align-top">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>
}

function LookupRows({ lookup }: { lookup: Lookup }) {
  const t = useT()
  const matchHeader = t('product_configurator.versions.lookups.match', 'When {keyedBy} is', { keyedBy: lookup.keyedBy })
  if (lookup.kind === 'value') {
    return (
      <ReadOnlyTable
        headers={[matchHeader, t('product_configurator.versions.lookups.value', 'Value')]}
        rows={lookup.rows.map((row, index) => ({ key: `${index}`, cells: [row.match, <Code key="value">{String(row.value)}</Code>] }))}
      />
    )
  }
  return (
    <ReadOnlyTable
      headers={[
        matchHeader,
        t('product_configurator.versions.lookups.allowed', 'Allowed values'),
        t('product_configurator.versions.lookups.default', 'Default'),
      ]}
      rows={lookup.rows.map((row, index) => ({ key: `${index}`, cells: [row.match, row.values.join(', '), row.default] }))}
    />
  )
}

export function DefinitionSections({ definition }: { definition: ConfigurationDefinition }) {
  const t = useT()
  const yes = t('product_configurator.versions.yes', 'Yes')
  const no = t('product_configurator.versions.no', 'No')

  return (
    <div className="space-y-6">
      <CollapsibleSection title={t('product_configurator.versions.sections.features', 'Features')} count={definition.features.length}>
        <ReadOnlyTable
          headers={[
            t('product_configurator.versions.columns.key', 'Key'),
            t('product_configurator.versions.columns.label', 'Label'),
            t('product_configurator.versions.columns.type', 'Type'),
            t('product_configurator.versions.columns.values', 'Values'),
            t('product_configurator.versions.columns.unit', 'Unit'),
            t('product_configurator.versions.columns.default', 'Default'),
            t('product_configurator.versions.columns.group', 'Group'),
            t('product_configurator.versions.columns.inSummary', 'In summary'),
            t('product_configurator.versions.columns.visibleWhen', 'Shown when'),
          ]}
          rows={sortByOrder(definition.features).map((feature) => ({
            key: feature.key,
            cells: [
              <Code key="key">{feature.key}</Code>,
              feature.label,
              t(FEATURE_TYPE_LABELS[feature.type].key, FEATURE_TYPE_LABELS[feature.type].fallback),
              <span key="values" className="flex flex-col">
                {formatFeatureValues(feature, t).map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </span>,
              feature.unit ?? '',
              <Code key="default">{formatValue(feature.default)}</Code>,
              feature.group ?? '',
              feature.inSummary ? yes : no,
              <Code key="when">{formatConditions(feature.visibleWhen, t)}</Code>,
            ],
          }))}
        />
      </CollapsibleSection>

      <CollapsibleSection title={t('product_configurator.versions.sections.formulas', 'Formulas')} count={definition.formulas.length}>
        <ReadOnlyTable
          headers={[
            t('product_configurator.versions.columns.key', 'Key'),
            t('product_configurator.versions.columns.label', 'Label'),
            t('product_configurator.versions.columns.expression', 'Expression'),
            t('product_configurator.versions.columns.unit', 'Unit'),
            t('product_configurator.versions.columns.decimals', 'Decimals'),
          ]}
          rows={definition.formulas.map((formula) => ({
            key: formula.key,
            cells: [
              <Code key="key">{formula.key}</Code>,
              formula.label ?? '',
              <Code key="expr">{formatExpression(formula.expr)}</Code>,
              formula.unit ?? '',
              formula.decimals ?? '',
            ],
          }))}
        />
      </CollapsibleSection>

      <CollapsibleSection title={t('product_configurator.versions.sections.lookups', 'Lookups')} count={definition.lookups.length}>
        {definition.lookups.length === 0 ? (
          <EmptyNote />
        ) : (
          <div className="space-y-4">
            {definition.lookups.map((lookup) => (
              <CollapsibleSection
                key={lookup.key}
                title={lookup.label ? `${lookup.label} (${lookup.key})` : lookup.key}
                count={lookup.rows.length}
                defaultCollapsed
              >
                <p className="mb-2 text-sm text-muted-foreground">
                  {lookup.kind === 'value'
                    ? t('product_configurator.versions.lookups.kindValue', 'Value lookup keyed by {keyedBy}', { keyedBy: lookup.keyedBy })
                    : t('product_configurator.versions.lookups.kindPermitted', 'Permitted values keyed by {keyedBy}', { keyedBy: lookup.keyedBy })}
                </p>
                <LookupRows lookup={lookup} />
              </CollapsibleSection>
            ))}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title={t('product_configurator.versions.sections.rules', 'Rules')} count={definition.rules.length}>
        <ReadOnlyTable
          headers={[
            t('product_configurator.versions.columns.rule', 'Rule'),
            t('product_configurator.versions.columns.effect', 'Effect'),
            t('product_configurator.versions.columns.when', 'When'),
            t('product_configurator.versions.columns.action', 'Action'),
            t('product_configurator.versions.columns.message', 'Message'),
            t('product_configurator.versions.columns.featureKeys', 'Fields highlighted for the rep'),
          ]}
          rows={sortByOrder(definition.rules).map((rule) => ({
            key: rule.id,
            cells: [
              <span key="rule" className="flex flex-col">
                {rule.label ? <span>{rule.label}</span> : null}
                <Code>{rule.id}</Code>
              </span>,
              t(RULE_EFFECT_LABELS[rule.effect].key, RULE_EFFECT_LABELS[rule.effect].fallback),
              <Code key="when">{formatConditions(rule.when, t)}</Code>,
              <Code key="action">{formatAction(rule.action, t)}</Code>,
              rule.messageTemplate,
              <Code key="fields">{rule.featureKeys.join(', ')}</Code>,
            ],
          }))}
        />
      </CollapsibleSection>

      <CollapsibleSection title={t('product_configurator.versions.sections.bom', 'BOM')} count={definition.bom.length}>
        <ReadOnlyTable
          headers={[
            t('product_configurator.versions.columns.id', 'ID'),
            t('product_configurator.versions.columns.sku', 'SKU'),
            t('product_configurator.versions.columns.quantity', 'Quantity'),
            t('product_configurator.versions.columns.uom', 'Unit'),
            t('product_configurator.versions.columns.when', 'When'),
            t('product_configurator.versions.columns.surchargeRule', 'Surcharge rule'),
          ]}
          rows={sortByOrder(definition.bom).map((line) => ({
            key: line.id,
            cells: [
              <Code key="id">{line.id}</Code>,
              <Code key="sku">{formatBomSku(line, t)}</Code>,
              <Code key="quantity">{formatBomQuantity(line)}</Code>,
              line.uom,
              <Code key="when">{formatConditions(line.when, t)}</Code>,
              line.ruleId ? <Code key="rule">{line.ruleId}</Code> : '',
            ],
          }))}
        />
      </CollapsibleSection>
    </div>
  )
}
