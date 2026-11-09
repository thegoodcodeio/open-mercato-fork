"use client"

import '@xyflow/react/dist/style.css'

import * as React from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { DependencyEdge, DependencyNode } from './dependencyGraphModel'

export type DependencyGraphCanvasProps = {
  nodes: readonly DependencyNode[]
  edges: readonly DependencyEdge[]
  kindLabels: Record<DependencyNode['kind'], string>
  onNodeClick: (node: DependencyNode) => void
}

type CanvasNodeData = { node: DependencyNode; kindLabel: string }
type CanvasNode = Node<CanvasNodeData, 'dependency'>

const HIDDEN_HANDLE_STYLE: React.CSSProperties = { opacity: 0 }

function DependencyCanvasNode({ data }: NodeProps<CanvasNode>) {
  const tone = data.node.inCycle ? 'border-status-error-border bg-status-error-bg' : 'border-border bg-card'
  return (
    <div className={`w-56 cursor-pointer rounded-md border px-3 py-2 text-left shadow-sm ${tone}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE_STYLE} />
      <div className="text-xs text-muted-foreground">{data.kindLabel}</div>
      <div className="truncate text-sm font-medium text-foreground" title={data.node.name}>
        {data.node.name}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE_STYLE} />
    </div>
  )
}

const NODE_TYPES: NodeTypes = { dependency: DependencyCanvasNode }

const BACKGROUND_DOT_COLOR = 'color-mix(in oklab, var(--muted-foreground) 22%, transparent)'

const EDGE_DASH: Record<DependencyEdge['kind'], string | undefined> = { reads: undefined, writes: '6 4', surcharge: '2 4' }

function edgeColor(edge: DependencyEdge): string {
  return edge.inCycle ? 'var(--status-error-icon)' : 'var(--muted-foreground)'
}

/** The `@xyflow/react` canvas, loaded on demand by `DependencyGraph`. Read-only: no drag, connect or select. */
export default function DependencyGraphCanvas({ nodes, edges, kindLabels, onNodeClick }: DependencyGraphCanvasProps) {
  const t = useT()
  const ariaLabelConfig = React.useMemo(
    () => ({
      'controls.ariaLabel': t('product_configurator.studio.dependencies.controls.label', 'Graph controls'),
      'controls.zoomIn.ariaLabel': t('product_configurator.studio.dependencies.controls.zoomIn', 'Zoom in'),
      'controls.zoomOut.ariaLabel': t('product_configurator.studio.dependencies.controls.zoomOut', 'Zoom out'),
      'controls.fitView.ariaLabel': t('product_configurator.studio.dependencies.controls.fitView', 'Fit the graph to the view'),
    }),
    [t],
  )
  const byId = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const canvasNodes = React.useMemo<CanvasNode[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: 'dependency',
        position: node.position,
        data: { node, kindLabel: kindLabels[node.kind] },
        draggable: false,
        connectable: false,
        selectable: false,
      })),
    [kindLabels, nodes],
  )
  const canvasEdges = React.useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        focusable: false,
        style: { stroke: edgeColor(edge), strokeWidth: edge.inCycle ? 2 : 1.5, strokeDasharray: EDGE_DASH[edge.kind] },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: edgeColor(edge) },
      })),
    [edges],
  )

  return (
    <ReactFlow
      nodes={canvasNodes}
      edges={canvasEdges}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_event, canvasNode) => {
        const node = byId.get(canvasNode.id)
        if (node) onNodeClick(node)
      }}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ padding: 0.1, maxZoom: 1.25 }}
      minZoom={0.1}
      ariaLabelConfig={ariaLabelConfig}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color={BACKGROUND_DOT_COLOR} />
      <Controls
        showInteractive={false}
        position="bottom-left"
        className="!bg-card !border-border !shadow-md [&>button]:!bg-card [&>button]:!border-border [&>button]:!fill-foreground [&>button:hover]:!bg-muted"
      />
    </ReactFlow>
  )
}
