"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import type { DependencyEdge, DependencyNode, DependencyNodeKind } from './dependencyGraphModel'

type DependencyNodeListProps = {
  nodes: readonly DependencyNode[]
  edges: readonly DependencyEdge[]
  kindTitles: Record<DependencyNodeKind, string>
  onOpen: (node: DependencyNode) => void
}

const LIST_KINDS: readonly DependencyNodeKind[] = ['feature', 'formula', 'lookup', 'rule', 'bom']

function countBy(edges: readonly DependencyEdge[], side: 'source' | 'target'): Map<string, number> {
  const counts = new Map<string, number>()
  for (const edge of edges) counts.set(edge[side], (counts.get(edge[side]) ?? 0) + 1)
  return counts
}

/** Keyboard path to every graph node: buttons grouped by section, in the order of the studio tabs. */
export function DependencyNodeList({ nodes, edges, kindTitles, onOpen }: DependencyNodeListProps) {
  const t = useT()
  const baseId = React.useId()
  const dependsOn = React.useMemo(() => countBy(edges, 'target'), [edges])
  const usedBy = React.useMemo(() => countBy(edges, 'source'), [edges])

  return (
    <div className="space-y-4" data-testid="dependency-node-list">
      {LIST_KINDS.map((kind) => {
        const items = nodes.filter((node) => node.kind === kind)
        if (items.length === 0) return null
        const headingId = `${baseId}-${kind}`
        return (
          <section key={kind} aria-labelledby={headingId} className="space-y-2">
            <h3 id={headingId} className="text-sm font-semibold text-foreground">
              {kindTitles[kind]}
            </h3>
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((node) => (
                <li key={node.id}>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onOpen(node)}
                    className="h-auto w-full flex-col items-start gap-1 whitespace-normal px-3 py-2 text-left"
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{node.name}</span>
                      {node.inCycle ? (
                        <StatusBadge variant="error">{t('product_configurator.studio.dependencies.inCycle', 'In a loop')}</StatusBadge>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('product_configurator.studio.dependencies.counts', 'Depends on {dependsOn}, used by {usedBy}', {
                        dependsOn: dependsOn.get(node.id) ?? 0,
                        usedBy: usedBy.get(node.id) ?? 0,
                      })}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
