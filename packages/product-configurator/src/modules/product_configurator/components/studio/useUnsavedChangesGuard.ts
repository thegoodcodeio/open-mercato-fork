"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'

function internalTarget(href: string | null): string | null {
  if (typeof window === 'undefined' || href == null) return null
  try {
    const url = new URL(href, window.location.href)
    if (url.origin !== window.location.origin) return null
    const target = `${url.pathname}${url.search}${url.hash}`
    const current = `${window.location.pathname}${window.location.search}`
    return target === current || target.startsWith(`${current}#`) ? null : target
  } catch {
    return null
  }
}

/**
 * Asks before leaving the studio with unsaved draft edits: the browser prompt on reload or close,
 * and the shared confirmation dialog for in-app links and browser Back and Forward. The studio is not
 * a `CrudForm`, so it mirrors that form's guard instead of reusing it.
 *
 * Back and Forward are cancelled through the Navigation API `navigate` event and replayed to the same
 * entry once the admin confirms. Browsers without that API cannot cancel a traversal before the app router
 * renders the other page, so there Back and Forward are not guarded; `beforeunload` still covers reload and close.
 */
export function useUnsavedChangesGuard(dirty: boolean, confirmLeave: () => Promise<boolean>): void {
  const router = useRouter()
  const dirtyRef = React.useRef(dirty)
  dirtyRef.current = dirty
  const leavingRef = React.useRef(false)
  const confirmPendingRef = React.useRef(false)

  React.useEffect(() => {
    if (dirty) leavingRef.current = false
  }, [dirty])

  React.useEffect(() => {
    const guarded = () => dirtyRef.current && !leavingRef.current

    const askToLeave = (leave: () => void) => {
      if (confirmPendingRef.current) return
      confirmPendingRef.current = true
      void confirmLeave()
        .then((confirmed) => {
          if (!confirmed) return
          leavingRef.current = true
          leave()
        })
        .finally(() => {
          confirmPendingRef.current = false
        })
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!guarded()) return
      event.preventDefault()
      event.returnValue = ''
    }
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !guarded() || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const target = internalTarget(anchor.getAttribute('href'))
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      askToLeave(() => router.push(target))
    }

    const navigation = typeof window.navigation === 'undefined' ? null : window.navigation
    const onNavigate = (event: NavigateEvent) => {
      if (event.navigationType !== 'traverse' || !event.cancelable || !guarded()) return
      const destination = event.destination.key
      event.preventDefault()
      askToLeave(() => void navigation?.traverseTo(destination).finished?.catch(() => undefined))
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClick, true)
    navigation?.addEventListener('navigate', onNavigate)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
      navigation?.removeEventListener('navigate', onNavigate)
    }
  }, [confirmLeave, router])
}
