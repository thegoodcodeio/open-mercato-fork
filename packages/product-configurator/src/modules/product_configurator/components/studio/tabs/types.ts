import type { ComponentType } from 'react'
import type { ConfigurationDefinition } from '../../../data/validators'
import type { ValidationIssue } from '../../../lib/validation/types'

export type StudioTabId =
  | 'overview'
  | 'features'
  | 'formulas'
  | 'lookups'
  | 'rules'
  | 'bom'
  | 'dependencies'
  | 'test'
  | 'advanced'

/** The in-memory draft. It always passes `definitionSchema`; cross-references are checked by Validate. */
export type StudioDefinition = ConfigurationDefinition

export type DefinitionUpdater = (definition: StudioDefinition) => StudioDefinition

export type StudioModelInfo = {
  id: string
  title: string
  modelKey: string
  productId: string
  currencyCode: string
  latestVersion: { id: string; version: number; hash: string; publishedAt: string } | null
  hasUnpublishedChanges: boolean
}

/** A validation issue of the last report, resolved to the row it points at (`key` is a feature/formula/lookup key or a rule/BOM id). */
export type StudioIssue = { issue: ValidationIssue; key: string | null }

/** Marks "add a new row" in `selectedKey`. `+` is not allowed in keys or ids, so it never collides with a row. */
export const STUDIO_NEW_ROW_KEY = '+new'

export type StudioTabProps = {
  model: StudioModelInfo
  /** Current draft, edited in memory until "Save draft". */
  definition: StudioDefinition
  /** Last saved draft (what Validate and Publish use); `null` when the saved draft does not parse. */
  savedDefinition: StudioDefinition | null
  /**
   * Changes the draft. Keep the updater pure and return a value that still passes `definitionSchema`.
   * `referenceChange` is the reference rewrite the update made (a key or id rename, a lookup's new
   * `keyedBy`); the studio keeps it in `referenceChanges` for row editors open in other tabs.
   */
  onChange: (update: DefinitionUpdater, referenceChange?: DefinitionUpdater) => void
  /**
   * Reference rewrites made since the draft was loaded, oldest first. A tab applies the ones made after its
   * row editor opened to the row it saves, so it does not write back a key that was renamed meanwhile.
   */
  referenceChanges?: readonly DefinitionUpdater[]
  /** True when the draft or a tab holds edits that are not saved yet (the Test tab says it tests the saved draft). */
  unsavedChanges?: boolean
  /** True while a save or publish runs; tabs must not change the draft then. */
  readOnly: boolean
  /** Issues of the last validation report that point at this tab. */
  issues: StudioIssue[]
  /** Row opened in this tab's row editor (kept by the studio across tab switches and set by report links). */
  selectedKey: string | null
  onSelectKey: (key: string | null) => void
  /** Opens another tab, optionally with a row selected (e.g. a graph node in Dependencies). */
  onNavigate: (tab: StudioTabId, key?: string | null) => void
  /** Optimistic-lock token of the model (`updatedAt`). Only the Overview title form writes with it. */
  lockToken: string | null
  /** Reports a write made outside "Save draft" (the Overview title form). */
  onModelSaved: (patch: { title?: string; updatedAt: string }) => void
  /** Handles a 409 from a write made outside "Save draft", so the studio refresh flow runs. */
  onConflict: (error: unknown) => void
  /**
   * Reports unsaved tab-local edits that live outside the draft (the Overview title form, an open row
   * editor), so the unsaved-changes guard also covers them. Report `false` again when they are saved,
   * reset or unmounted.
   */
  onDirtyChange?: (dirty: boolean) => void
  /** Reports Advanced JSON text typed but not applied (`null` when there is none). */
  onPendingJsonChange?: (text: string | null) => void
}

export type StudioTabDefinition = {
  id: StudioTabId
  labelKey: string
  fallbackLabel: string
  component: ComponentType<StudioTabProps>
}
