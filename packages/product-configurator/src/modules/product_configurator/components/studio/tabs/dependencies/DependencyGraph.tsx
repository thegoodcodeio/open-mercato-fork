"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import type { DependencyGraphCanvasProps } from './DependencyGraphCanvas'

type CanvasState =
  | { status: 'loading' }
  | { status: 'ready'; Canvas: React.ComponentType<DependencyGraphCanvasProps> }
  | { status: 'failed' }

/**
 * Loads `@xyflow/react` only when the Dependencies tab is shown, so the studio bundle does not carry it.
 * A late import after unmount is ignored; unmounting the canvas lets React Flow drop its store and listeners.
 */
export function DependencyGraph(props: DependencyGraphCanvasProps) {
  const t = useT()
  const [state, setState] = React.useState<CanvasState>({ status: 'loading' })

  React.useEffect(() => {
    let disposed = false
    import('./DependencyGraphCanvas').then(
      (module) => {
        if (!disposed) setState({ status: 'ready', Canvas: module.default })
      },
      () => {
        if (!disposed) setState({ status: 'failed' })
      },
    )
    return () => {
      disposed = true
    }
  }, [])

  return (
    <div
      role="region"
      aria-label={t('product_configurator.studio.dependencies.graphLabel', 'Dependency graph. Use the list to open items with the keyboard.')}
      className="h-96 overflow-hidden rounded-md border border-border bg-background"
      data-testid="dependency-graph"
    >
      {state.status === 'ready' ? (
        <state.Canvas {...props} />
      ) : state.status === 'failed' ? (
        <ErrorMessage label={t('product_configurator.studio.dependencies.loadFailed', 'Could not load the graph. Use the list to open items.')} />
      ) : (
        <LoadingMessage label={t('product_configurator.studio.dependencies.loading', 'Loading the graph…')} />
      )}
    </div>
  )
}
