"use client"

import * as React from 'react'
import type { DefinitionUpdater, StudioDefinition } from './types'

/**
 * Reports a row editor's unsaved edits to the studio guard: values that differ from the ones the editor
 * opened with, or nested text that does not parse yet. Reports `false` when the editor closes.
 * `comparable` drops what the editor fills in by itself (e.g. blank placeholder rows), so it does not count.
 */
export function useRowEditorDirty<Values>(
  values: Values,
  hasInvalid: boolean,
  onDirtyChange: ((dirty: boolean) => void) | undefined,
  comparable: (values: Values) => unknown = (current) => current,
): void {
  const [initial] = React.useState(() => JSON.stringify(comparable(values)))
  const dirty = hasInvalid || JSON.stringify(comparable(values)) !== initial
  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  React.useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
}

/** The reference rewrites made after the row editor for `selectedKey` opened. */
export function useReferenceChangesSince(
  selectedKey: string | null,
  referenceChanges: readonly DefinitionUpdater[] = [],
): readonly DefinitionUpdater[] {
  const [session, setSession] = React.useState({ key: selectedKey, start: referenceChanges.length })
  if (session.key !== selectedKey) setSession({ key: selectedKey, start: referenceChanges.length })
  return session.key === selectedKey ? referenceChanges.slice(session.start) : []
}

/** Applies reference rewrites in order. They never touch declarations, so a draft whose list holds only the saved row rewrites just that row. */
export function applyReferenceChanges(definition: StudioDefinition, changes: readonly DefinitionUpdater[]): StudioDefinition {
  return changes.reduce((current, change) => change(current), definition)
}
