/**
 * @jest-environment jsdom
 */
import { TextEncoder } from 'node:util'
import * as React from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@open-mercato/shared/lib/testing/renderWithProviders'
import { build } from '../../../lib/__tests__/fixtures'
import type { ValidationIssue } from '../../../lib/validation/types'
import type { DependencyGraphCanvasProps } from '../tabs/dependencies/DependencyGraphCanvas'
import type { StudioTabProps } from '../tabs/types'

// jsdom has no TextEncoder; the definition schema measures the draft size with it.
Object.assign(globalThis, { TextEncoder })

const canvasUnmounted = jest.fn()

jest.mock('../tabs/dependencies/DependencyGraphCanvas', () => {
  function MockCanvas({ nodes, onNodeClick }: DependencyGraphCanvasProps) {
    React.useEffect(() => () => canvasUnmounted(), [])
    return (
      <div data-testid="mock-canvas">
        {nodes.map((node) => (
          <span key={node.id} data-testid={`canvas-node-${node.id}`} data-in-cycle={String(node.inCycle)} onClick={() => onNodeClick(node)}>
            {node.name}
          </span>
        ))}
      </div>
    )
  }
  return { __esModule: true, default: MockCanvas }
})

import { DependenciesTab } from '../tabs/DependenciesTab'

function renderTab(overrides: Partial<StudioTabProps> = {}) {
  const definition = build()
  const props: StudioTabProps = {
    model: {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Pump',
      modelKey: 'pump',
      productId: '22222222-2222-4222-8222-222222222222',
      currencyCode: 'EUR',
      latestVersion: null,
      hasUnpublishedChanges: true,
    },
    definition,
    savedDefinition: definition,
    onChange: jest.fn(),
    readOnly: false,
    issues: [],
    selectedKey: null,
    onSelectKey: jest.fn(),
    onNavigate: jest.fn(),
    lockToken: null,
    onModelSaved: jest.fn(),
    onConflict: jest.fn(),
    ...overrides,
  }
  return { props, ...renderWithProviders(<DependenciesTab {...props} />) }
}

describe('DependenciesTab', () => {
  beforeEach(() => canvasUnmounted.mockClear())

  it('loads the canvas through the dynamic import and navigates when a node is clicked', async () => {
    const { props } = renderTab()
    expect(screen.getByText('Loading the graph…')).toBeTruthy()
    fireEvent.click(await screen.findByTestId('canvas-node-formula:pipe_meters'))
    expect(props.onNavigate).toHaveBeenCalledWith('formulas', 'pipe_meters')
  })

  it('offers every node as a keyboard-reachable button in the list', async () => {
    const { props } = renderTab()
    await screen.findByTestId('mock-canvas')
    const list = screen.getByTestId('dependency-node-list')
    const button = within(list).getByRole('button', { name: /Pipe length \(length\)/ })
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(props.onNavigate).toHaveBeenCalledWith('features', 'length')
    fireEvent.click(within(list).getByRole('button', { name: /PIPE-M \(pipe\)/ }))
    expect(props.onNavigate).toHaveBeenLastCalledWith('bom', 'pipe')
    expect(within(list).getByRole('heading', { name: 'Lookups' })).toBeTruthy()
  })

  it('marks loops from the last validation report', async () => {
    const issue: ValidationIssue = {
      check: 'formula_cycle',
      code: 'formula_cycle',
      params: { formulaKeys: ['pipe_meters', 'weight'] },
      refs: [{ kind: 'formula', key: 'pipe_meters' }, { kind: 'formula', key: 'weight' }],
    }
    renderTab({ issues: [{ issue, key: null }] })
    expect(screen.getByTestId('dependency-cycles')).toBeTruthy()
    expect((await screen.findByTestId('canvas-node-formula:pipe_meters')).getAttribute('data-in-cycle')).toBe('true')
    expect(screen.getByTestId('canvas-node-feature:length').getAttribute('data-in-cycle')).toBe('false')
    expect(within(screen.getByTestId('dependency-node-list')).getAllByText('In a loop')).toHaveLength(2)
  })

  it('disposes the canvas on unmount', async () => {
    const { unmount } = renderTab()
    await screen.findByTestId('mock-canvas')
    unmount()
    expect(canvasUnmounted).toHaveBeenCalledTimes(1)
  })

  it('shows an empty state for a draft with nothing in it', () => {
    const empty = build((input) => {
      input.features = []
      input.formulas = []
      input.lookups = []
      input.rules = []
      input.bom = []
    })
    renderTab({ definition: empty })
    expect(screen.getByText('Nothing to show yet')).toBeTruthy()
    expect(screen.queryByTestId('dependency-graph')).toBeNull()
  })
})
