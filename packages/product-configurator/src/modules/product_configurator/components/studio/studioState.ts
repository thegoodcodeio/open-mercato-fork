import { definitionSchema } from '../../data/validators'
import type { ValidationReport } from '../../lib/validation/types'
import type { DefinitionUpdater, StudioDefinition, StudioModelInfo, StudioTabId } from './tabs/types'

/** What `GET /models?id=` returns for the studio, already narrowed by `parseModelDetail`. */
export type StudioModelDetail = StudioModelInfo & {
  updatedAt: string | null
  draftDefinition: unknown
}

/** Result of loading the model again; `notFound` means it was deleted meanwhile. */
export type StudioReloadResult = { status: 'ready'; detail: StudioModelDetail } | { status: 'notFound' } | { status: 'error' }

export type StudioReport = { source: 'validate' | 'publish'; checkedAt: string; report: ValidationReport }

export type StudioPublished = { version: number; modelVersionId: string; hash: string }

export type StudioState = {
  model: StudioModelInfo
  /** Optimistic-lock token: the `updatedAt` this studio last saw from the server. */
  lockToken: string | null
  savedRaw: unknown
  savedDefinition: StudioDefinition | null
  savedJson: string
  /** `null` only when the saved draft does not parse; the studio then offers the JSON repair view. */
  draft: StudioDefinition | null
  draftJson: string
  /** Bumped when the draft is replaced from outside the tabs (discard, refresh), so tab-local editors reset. */
  epoch: number
  /** Reference rewrites made by row saves in this epoch, oldest first (see `StudioTabProps.referenceChanges`). */
  referenceChanges: DefinitionUpdater[]
  activeTab: StudioTabId
  selectedKeys: Partial<Record<StudioTabId, string | null>>
  report: StudioReport | null
  published: StudioPublished | null
  conflict: boolean
}

export type StudioAction =
  | { type: 'loaded'; detail: StudioModelDetail }
  | { type: 'edit'; update: DefinitionUpdater; referenceChange?: DefinitionUpdater }
  /** Replaces the whole draft (Advanced JSON, also when the saved draft does not parse). */
  | { type: 'replace'; definition: StudioDefinition }
  | { type: 'saved'; definition: StudioDefinition; updatedAt: string; draftHash: string }
  | { type: 'titleSaved'; title?: string; updatedAt: string }
  | { type: 'discard' }
  | { type: 'selectTab'; tab: StudioTabId }
  | { type: 'selectKey'; tab: StudioTabId; key: string | null }
  | { type: 'navigate'; tab: StudioTabId; key: string | null }
  | { type: 'report'; report: StudioReport | null }
  | { type: 'published'; published: StudioPublished; updatedAt: string; publishedAt: string }
  | { type: 'conflict' }

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

export function parseDraft(raw: unknown): StudioDefinition | null {
  const parsed = definitionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function loadedState(detail: StudioModelDetail, previous: StudioState | null): StudioState {
  const { updatedAt, draftDefinition, ...model } = detail
  const savedDefinition = parseDraft(draftDefinition)
  const savedJson = serialize(savedDefinition ?? draftDefinition)
  return {
    model,
    lockToken: updatedAt,
    savedRaw: draftDefinition,
    savedDefinition,
    savedJson,
    draft: savedDefinition,
    draftJson: savedJson,
    epoch: (previous?.epoch ?? 0) + 1,
    referenceChanges: [],
    activeTab: savedDefinition ? (previous?.activeTab ?? 'overview') : 'advanced',
    selectedKeys: {},
    report: null,
    published: null,
    conflict: false,
  }
}

export function createStudioState(detail: StudioModelDetail): StudioState {
  return loadedState(detail, null)
}

export function isDraftDirty(state: StudioState): boolean {
  return state.draftJson !== state.savedJson
}

export function studioReducer(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'loaded':
      return loadedState(action.detail, state)
    case 'edit': {
      if (!state.draft) return state
      const next = action.update(state.draft)
      if (next === state.draft) return state
      const referenceChanges = action.referenceChange ? [...state.referenceChanges, action.referenceChange] : state.referenceChanges
      return { ...state, draft: next, draftJson: serialize(next), published: null, referenceChanges }
    }
    case 'replace':
      return { ...state, draft: action.definition, draftJson: serialize(action.definition), published: null }
    case 'saved': {
      const savedJson = serialize(action.definition)
      return {
        ...state,
        lockToken: action.updatedAt,
        savedRaw: action.definition,
        savedDefinition: action.definition,
        savedJson,
        model: {
          ...state.model,
          hasUnpublishedChanges: state.model.latestVersion !== null && state.model.latestVersion.hash !== action.draftHash,
        },
        report: null,
        conflict: false,
      }
    }
    case 'titleSaved':
      return {
        ...state,
        lockToken: action.updatedAt,
        model: action.title === undefined ? state.model : { ...state.model, title: action.title },
        conflict: false,
      }
    case 'discard':
      return {
        ...state,
        draft: state.savedDefinition,
        draftJson: state.savedJson,
        epoch: state.epoch + 1,
        referenceChanges: [],
        selectedKeys: {},
        activeTab: state.savedDefinition ? state.activeTab : 'advanced',
      }
    case 'selectTab':
      return state.activeTab === action.tab ? state : { ...state, activeTab: action.tab }
    case 'selectKey':
      return { ...state, selectedKeys: { ...state.selectedKeys, [action.tab]: action.key } }
    case 'navigate':
      return { ...state, activeTab: action.tab, selectedKeys: { ...state.selectedKeys, [action.tab]: action.key } }
    case 'report':
      return { ...state, report: action.report, published: action.report ? null : state.published }
    case 'published':
      return {
        ...state,
        lockToken: action.updatedAt,
        model: {
          ...state.model,
          latestVersion: {
            id: action.published.modelVersionId,
            version: action.published.version,
            hash: action.published.hash,
            publishedAt: action.publishedAt,
          },
          hasUnpublishedChanges: false,
        },
        published: action.published,
        report: null,
        conflict: false,
      }
    case 'conflict':
      return state.conflict ? state : { ...state, conflict: true }
  }
}
