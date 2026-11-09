"use client"

import * as React from 'react'
import type { SelectionValue } from '../../data/validators'
import type { EvaluateOutcome, WorkspaceEvaluation, WorkspaceFailure, WorkspaceSelections } from './evaluationSchema'

export type ConfiguratorEvaluateFn = (selections: WorkspaceSelections) => Promise<EvaluateOutcome>

export type ConfiguratorEvaluationState = {
  /** What the user chose (intent); values set by rules live only in `evaluation.selections`. */
  selections: WorkspaceSelections
  /** Last successful result, kept while a newer request runs or fails. */
  evaluation: WorkspaceEvaluation | null
  pending: boolean
  failure: WorkspaceFailure | null
  setSelection: (featureKey: string, value: SelectionValue | null) => void
  retry: () => void
  /** Replaces the choices and the shown result without evaluating (a reviewed session conflict, a confirmed new price); drops requests in flight. */
  reset: (next: { selections: WorkspaceSelections; evaluation: WorkspaceEvaluation | null }) => void
  /** Grows on every `reset`, so fields drop text being typed even when the reset keeps their value. */
  resetGeneration: number
}

/**
 * Evaluates the choices on mount, on every change and whenever `evaluate` changes (a new pricing context or a
 * new saved draft). Only the newest request updates the state, so a slow older answer never overwrites it.
 * `initialEvaluation` (a stored session result) is shown while the first evaluation runs.
 */
export function useConfiguratorEvaluation(
  evaluate: ConfiguratorEvaluateFn,
  initialSelections: WorkspaceSelections = {},
  initialEvaluation: WorkspaceEvaluation | null = null,
): ConfiguratorEvaluationState {
  const [selections, setSelections] = React.useState<WorkspaceSelections>(initialSelections)
  const [evaluation, setEvaluation] = React.useState<WorkspaceEvaluation | null>(initialEvaluation)
  const [pending, setPending] = React.useState(true)
  const [failure, setFailure] = React.useState<WorkspaceFailure | null>(null)
  const [resetGeneration, setResetGeneration] = React.useState(0)
  const selectionsRef = React.useRef(selections)
  const requestRef = React.useRef(0)
  const evaluateRef = React.useRef(evaluate)
  evaluateRef.current = evaluate

  const run = React.useCallback(async (next: WorkspaceSelections) => {
    const request = ++requestRef.current
    setPending(true)
    let outcome: EvaluateOutcome
    try {
      outcome = await evaluateRef.current(next)
    } catch {
      outcome = { ok: false, failure: { kind: 'transient' } }
    }
    if (request !== requestRef.current) return
    setPending(false)
    if (outcome.ok) {
      setEvaluation(outcome.evaluation)
      setFailure(null)
    } else {
      setFailure(outcome.failure)
    }
  }, [])

  React.useEffect(() => {
    void run(selectionsRef.current)
  }, [evaluate, run])

  React.useEffect(
    () => () => {
      requestRef.current += 1
    },
    [],
  )

  const setSelection = React.useCallback(
    (featureKey: string, value: SelectionValue | null) => {
      const next = { ...selectionsRef.current }
      if (value === null) delete next[featureKey]
      else next[featureKey] = value
      selectionsRef.current = next
      setSelections(next)
      void run(next)
    },
    [run],
  )

  const retry = React.useCallback(() => void run(selectionsRef.current), [run])

  const reset = React.useCallback((next: { selections: WorkspaceSelections; evaluation: WorkspaceEvaluation | null }) => {
    requestRef.current += 1
    selectionsRef.current = next.selections
    setSelections(next.selections)
    setEvaluation(next.evaluation)
    setFailure(null)
    setPending(false)
    setResetGeneration((generation) => generation + 1)
  }, [])

  return { selections, evaluation, pending, failure, setSelection, retry, reset, resetGeneration }
}
