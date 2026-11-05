import type { z } from 'zod'
import { DEFINITION_LIMITS, definitionSchema, type ConfigurationDefinition } from '../../data/validators'
import type { ValidationIssue } from './types'

type ZodIssue = z.ZodError['issues'][number]

export type SchemaResult = { definition: ConfigurationDefinition; issues: [] } | { definition: null; issues: ValidationIssue[] }

export function parseDefinitionForPublication(raw: unknown): SchemaResult {
  const parsed = definitionSchema.safeParse(raw)
  if (parsed.success) return { definition: parsed.data, issues: [] }
  return { definition: null, issues: parsed.error.issues.map(toValidationIssue) }
}

function toValidationIssue(issue: ZodIssue): ValidationIssue {
  const path = issue.path.map(String).join('.')
  const refs = path ? [{ kind: 'path' as const, path }] : []
  if (issue.code === 'custom' && issue.message === 'too_large') {
    return { check: 'limits', code: 'definition_too_large', params: { limit: DEFINITION_LIMITS.definitionBytes }, refs }
  }
  if (issue.code === 'custom' && issue.message === 'too_deep') {
    return { check: 'limits', code: 'definition_too_deep', params: { limit: DEFINITION_LIMITS.jsonNestingDepth }, refs }
  }
  if (issue.code === 'custom' && issue.message === 'expression_too_deep') {
    return { check: 'limits', code: 'expression_too_deep', params: { path, limit: DEFINITION_LIMITS.expressionDepth }, refs }
  }
  if (issue.code === 'too_big' && issue.origin === 'array') {
    return { check: 'limits', code: 'limit_exceeded', params: { path, limit: Number(issue.maximum) }, refs }
  }
  if (issue.code === 'too_small' && issue.origin === 'number' && isBomQuantityPath(issue.path)) {
    return { check: 'schema', code: 'bom_negative_quantity', params: { path }, refs }
  }
  const reason = issue.code === 'custom' ? issue.message : issue.code
  return { check: 'schema', code: 'schema_invalid', params: { path, reason }, refs }
}

function isBomQuantityPath(path: readonly PropertyKey[]): boolean {
  return path.length === 3 && path[0] === 'bom' && path[2] === 'quantity'
}
