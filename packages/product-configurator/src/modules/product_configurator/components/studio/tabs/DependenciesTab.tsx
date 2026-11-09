"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { TabEmptyState } from '@open-mercato/ui/backend/detail'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { issueMessage } from '../validationMessages'
import { DependencyGraph } from './dependencies/DependencyGraph'
import { buildDependencyGraph, type DependencyNode, type DependencyNodeKind } from './dependencies/dependencyGraphModel'
import { DependencyNodeList } from './dependencies/DependencyNodeList'
import type { StudioTabProps } from './types'

/** Read-only map of the draft: every node opens its row in the owning tab. */
export function DependenciesTab({ definition, savedDefinition, issues, onNavigate }: StudioTabProps) {
  const t = useT()
  const reportIssues = React.useMemo(() => [...new Set(issues.map((entry) => entry.issue))], [issues])
  const graph = React.useMemo(() => buildDependencyGraph(definition, reportIssues), [definition, reportIssues])
  const openNode = React.useCallback((node: DependencyNode) => onNavigate(node.tab, node.key), [onNavigate])

  const kindLabels = React.useMemo<Record<DependencyNodeKind, string>>(
    () => ({
      feature: t('product_configurator.studio.dependencies.kinds.feature', 'Feature'),
      formula: t('product_configurator.studio.dependencies.kinds.formula', 'Formula'),
      lookup: t('product_configurator.studio.dependencies.kinds.lookup', 'Lookup'),
      rule: t('product_configurator.studio.dependencies.kinds.rule', 'Rule'),
      bom: t('product_configurator.studio.dependencies.kinds.bom', 'BOM line'),
    }),
    [t],
  )
  const kindTitles = React.useMemo<Record<DependencyNodeKind, string>>(
    () => ({
      feature: t('product_configurator.studio.tabs.features', 'Features'),
      formula: t('product_configurator.studio.tabs.formulas', 'Formulas'),
      lookup: t('product_configurator.studio.tabs.lookups', 'Lookups'),
      rule: t('product_configurator.studio.tabs.rules', 'Rules'),
      bom: t('product_configurator.studio.tabs.bom', 'BOM'),
    }),
    [t],
  )

  if (graph.nodes.length === 0) {
    return (
      <TabEmptyState
        title={t('product_configurator.studio.dependencies.emptyTitle', 'Nothing to show yet')}
        description={t(
          'product_configurator.studio.dependencies.emptyText',
          'Add features, formulas, lookups, rules or BOM lines to see how they use each other.',
        )}
      />
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t(
          'product_configurator.studio.dependencies.intro',
          'How features, formulas, lookups, rules and BOM lines use each other in the current draft. Click an item to open it.',
        )}
      </p>
      {graph.cycleIssues.length > 0 ? (
        <Alert status="error" data-testid="dependency-cycles">
          <AlertTitle>{t('product_configurator.studio.dependencies.cyclesTitle', 'Loops found by the last validation')}</AlertTitle>
          <AlertDescription>
            <p>{t('product_configurator.studio.dependencies.cyclesHint', 'They are marked in the graph and the list. The report is for the saved draft.')}</p>
            <ul className="mt-1 list-disc pl-5">
              {graph.cycleIssues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>{issueMessage(issue, savedDefinition, t)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <DependencyGraph nodes={graph.nodes} edges={graph.edges} kindLabels={kindLabels} onNodeClick={openNode} />
      <ul
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label={t('product_configurator.studio.dependencies.legendLabel', 'Legend')}
      >
        <li>{t('product_configurator.studio.dependencies.legend.reads', 'Solid line: uses')}</li>
        <li>{t('product_configurator.studio.dependencies.legend.writes', 'Dashed line: a rule sets the value')}</li>
        <li>{t('product_configurator.studio.dependencies.legend.surcharge', 'Dotted line: BOM line bound to a surcharge rule')}</li>
        <li>{t('product_configurator.studio.dependencies.legend.cycle', 'Red: part of a loop')}</li>
      </ul>
      <DependencyNodeList nodes={graph.nodes} edges={graph.edges} kindTitles={kindTitles} onOpen={openNode} />
    </div>
  )
}
