import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { IssueParamValue } from '../../lib/evaluator/types'
import {
  VALIDATION_CHECK_LABEL_KEYS,
  VALIDATION_MESSAGE_KEYS,
  type ValidationIssue,
} from '../../lib/validation/types'
import { anyName, featureName, formulaName, lookupName, ruleName } from './names'
import type { StudioDefinition } from './tabs/types'

type Namer = (definition: StudioDefinition | null, key: string) => string

const PARAM_NAMERS: Record<string, Namer> = {
  featureKey: featureName,
  keyedBy: featureName,
  featureKeys: featureName,
  formulaKey: formulaName,
  formulaKeys: formulaName,
  lookupKey: lookupName,
  ruleId: ruleName,
  ruleIds: ruleName,
  ownerKey: anyName,
  key: anyName,
}

function formatParam(name: string, value: IssueParamValue, definition: StudioDefinition | null, namer: Namer | undefined): string {
  if (Array.isArray(value)) return value.map((entry) => formatParam(name, entry, definition, namer)).join(', ')
  if (value === null) return ''
  if (typeof value === 'string' && namer) return namer(definition, value)
  return String(value)
}

/** Params with keys replaced by "Friendly name (key)" from the saved draft, ready for `t(key, fallback, params)`. */
export function friendlyIssueParams(issue: ValidationIssue, definition: StudioDefinition | null): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [name, value] of Object.entries(issue.params)) {
    const namer = name === 'expected' && issue.code === 'lookup_keyed_by_mismatch' ? featureName : PARAM_NAMERS[name]
    params[name] = formatParam(name, value, definition, namer)
  }
  return params
}

export function issueMessage(issue: ValidationIssue, definition: StudioDefinition | null, t: TranslateFn): string {
  const messageKey = VALIDATION_MESSAGE_KEYS[issue.code] ?? 'product_configurator.validation.codes.schema_invalid'
  return t(messageKey, issue.code, friendlyIssueParams(issue, definition))
}

export function issueCheckLabel(issue: ValidationIssue, t: TranslateFn): string {
  const labelKey = VALIDATION_CHECK_LABEL_KEYS[issue.check]
  return labelKey ? t(labelKey, issue.check) : issue.check
}
