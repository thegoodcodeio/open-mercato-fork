/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'

const pushMock = jest.fn()

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))

import { useUnsavedChangesGuard } from '../useUnsavedChangesGuard'

function deferred() {
  let resolve: (value: boolean) => void = () => undefined
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function installNavigation() {
  const traverseTo = jest.fn(() => ({ committed: Promise.resolve(), finished: Promise.resolve() }))
  const navigation = Object.assign(new EventTarget(), { traverseTo })
  Object.defineProperty(window, 'navigation', { value: navigation, configurable: true })
  const traverse = (cancelable: boolean) => {
    const event = Object.assign(new Event('navigate', { cancelable }), { navigationType: 'traverse', destination: { key: 'list-entry' } })
    act(() => {
      navigation.dispatchEvent(event)
    })
    return event
  }
  return { navigation, traverseTo, traverse }
}

function clickLink(href: string): boolean {
  const anchor = document.createElement('a')
  anchor.setAttribute('href', href)
  document.body.appendChild(anchor)
  let reachedLink = false
  anchor.addEventListener('click', (event) => {
    reachedLink = true
    event.preventDefault()
  })
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  act(() => {
    anchor.dispatchEvent(event)
  })
  anchor.remove()
  return event.defaultPrevented && !reachedLink
}

beforeEach(() => {
  pushMock.mockReset()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'navigation')
})

describe('useUnsavedChangesGuard', () => {
  it('cancels a Back or Forward through the Navigation API and traverses to the same entry after confirmation', async () => {
    const { traverseTo, traverse } = installNavigation()
    const answer = deferred()
    const { rerender } = renderHook(({ dirty }) => useUnsavedChangesGuard(dirty, () => answer.promise), { initialProps: { dirty: true } })

    expect(traverse(true).defaultPrevented).toBe(true)
    expect(traverse(false).defaultPrevented).toBe(false)
    expect(traverseTo).not.toHaveBeenCalled()
    answer.resolve(true)
    await settle()
    expect(traverseTo).toHaveBeenCalledWith('list-entry')

    rerender({ dirty: false })
    expect(traverse(true).defaultPrevented).toBe(false)
  })

  it('keeps the studio when the admin cancels and asks again on the next traversal', async () => {
    const { traverseTo, traverse } = installNavigation()
    const confirmLeave = jest.fn(async () => false)
    renderHook(() => useUnsavedChangesGuard(true, confirmLeave))

    expect(traverse(true).defaultPrevented).toBe(true)
    await settle()
    expect(traverse(true).defaultPrevented).toBe(true)
    await settle()
    expect(confirmLeave).toHaveBeenCalledTimes(2)
    expect(traverseTo).not.toHaveBeenCalled()
  })

  it('shows one dialog for traversals made while it is open', async () => {
    const { traverse } = installNavigation()
    const answer = deferred()
    const confirmLeave = jest.fn(() => answer.promise)
    renderHook(() => useUnsavedChangesGuard(true, confirmLeave))

    traverse(true)
    traverse(true)
    expect(confirmLeave).toHaveBeenCalledTimes(1)
    answer.resolve(false)
    await settle()
  })

  it('lets non-traverse navigations through', () => {
    const { navigation } = installNavigation()
    const confirmLeave = jest.fn(async () => true)
    renderHook(() => useUnsavedChangesGuard(true, confirmLeave))

    const event = Object.assign(new Event('navigate', { cancelable: true }), { navigationType: 'push', destination: { key: 'next' } })
    act(() => {
      navigation.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
    expect(confirmLeave).not.toHaveBeenCalled()
  })

  it('neither intercepts Back or Forward nor patches anything global when the Navigation API is absent', () => {
    const pushState = window.history.pushState
    const replaceState = window.history.replaceState
    const stateDescriptor = Object.getOwnPropertyDescriptor(PopStateEvent.prototype, 'state')
    const routerListener = jest.fn()
    window.addEventListener('popstate', routerListener)
    const confirmLeave = jest.fn(async () => true)
    try {
      renderHook(() => useUnsavedChangesGuard(true, confirmLeave))
      expect(window.history.pushState).toBe(pushState)
      expect(window.history.replaceState).toBe(replaceState)
      expect(Object.getOwnPropertyDescriptor(PopStateEvent.prototype, 'state')).toEqual(stateDescriptor)

      const event = new PopStateEvent('popstate', { state: { page: 'list' } })
      act(() => {
        window.dispatchEvent(event)
      })
      expect(routerListener).toHaveBeenCalledTimes(1)
      expect(event.state).toEqual({ page: 'list' })
      expect(confirmLeave).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('popstate', routerListener)
    }
  })

  it('asks before following an in-app link and navigates after confirmation', async () => {
    const answer = deferred()
    renderHook(() => useUnsavedChangesGuard(true, () => answer.promise))

    expect(clickLink('/backend/elsewhere')).toBe(true)
    expect(pushMock).not.toHaveBeenCalled()
    answer.resolve(true)
    await settle()
    expect(pushMock).toHaveBeenCalledWith('/backend/elsewhere')

    expect(clickLink('/backend/other')).toBe(false)
  })

  it('does not ask anything while clean', () => {
    const { traverse } = installNavigation()
    const confirmLeave = jest.fn(async () => true)
    renderHook(() => useUnsavedChangesGuard(false, confirmLeave))

    expect(clickLink('/backend/elsewhere')).toBe(false)
    expect(traverse(true).defaultPrevented).toBe(false)
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(false)
    expect(confirmLeave).not.toHaveBeenCalled()
  })

  it('blocks reload and close while dirty', () => {
    renderHook(() => useUnsavedChangesGuard(true, jest.fn(async () => true)))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
