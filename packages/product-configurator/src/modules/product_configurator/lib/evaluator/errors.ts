import type { SelectionValue } from '../../data/validators'
import type { IssueParams } from './types'

export type EvaluationErrorCode =
  | 'invalid_selection'
  | 'fixed_point_not_reached'
  | 'forced_value_invalid'
  | 'expression_error'
  | 'price_missing'

export type SelectionIssueReason = 'unknown_feature' | 'type' | 'below_min' | 'above_max' | 'step' | 'not_an_option'

export type SelectionIssue = { featureKey: string; reason: SelectionIssueReason; value: SelectionValue | null }

export class ConfiguratorEvaluationError extends Error {
  readonly code: EvaluationErrorCode
  readonly params: IssueParams
  readonly issues: SelectionIssue[]

  constructor(code: EvaluationErrorCode, params: IssueParams = {}, issues: SelectionIssue[] = []) {
    super(`[internal] product_configurator evaluation failed: ${code}`)
    this.name = 'ConfiguratorEvaluationError'
    this.code = code
    this.params = params
    this.issues = issues
  }
}
