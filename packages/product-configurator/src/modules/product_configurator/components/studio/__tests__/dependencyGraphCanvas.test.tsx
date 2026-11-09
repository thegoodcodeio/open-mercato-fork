/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'

type CapturedProps = Record<string, unknown>

const captured: { flow?: CapturedProps; controls?: CapturedProps; background?: CapturedProps } = {}

jest.mock('@xyflow/react/dist/style.css', () => ({}))

jest.mock('@xyflow/react', () => ({
  ReactFlow: ({ children, ...props }: CapturedProps & { children?: React.ReactNode }) => {
    captured.flow = props
    return <div>{children}</div>
  },
  Controls: (props: CapturedProps) => {
    captured.controls = props
    return null
  },
  Background: (props: CapturedProps) => {
    captured.background = props
    return null
  },
  BackgroundVariant: { Dots: 'dots' },
  Handle: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
}))

import DependencyGraphCanvas from '../tabs/dependencies/DependencyGraphCanvas'

describe('DependencyGraphCanvas', () => {
  it('hides the attribution, themes the controls and translates their labels', () => {
    renderWithProviders(
      <DependencyGraphCanvas
        nodes={[]}
        edges={[]}
        kindLabels={{ feature: 'Feature', formula: 'Formula', lookup: 'Lookup', rule: 'Rule', bom: 'BOM line' }}
        onNodeClick={jest.fn()}
      />,
      { dict: { 'product_configurator.studio.dependencies.controls.zoomIn': 'Przybliż' } },
    )
    expect(captured.flow?.proOptions).toEqual({ hideAttribution: true })
    expect(captured.flow?.ariaLabelConfig).toEqual({
      'controls.ariaLabel': 'Graph controls',
      'controls.zoomIn.ariaLabel': 'Przybliż',
      'controls.zoomOut.ariaLabel': 'Zoom out',
      'controls.fitView.ariaLabel': 'Fit the graph to the view',
    })
    expect(String(captured.controls?.className)).toContain('!bg-card')
    expect(captured.background?.variant).toBe('dots')
  })
})
