import type { IssueParams } from '../evaluator/types'

export const VALIDATION_CHECKS = [
  'schema',
  'limits',
  'lookup_coverage',
  'duplicate_key',
  'referential_integrity',
  'ambiguous_sku',
  'bom_unit_mismatch',
  'formula_cycle',
  'fixed_point',
  'numeric_expr_reference',
  'default_valid',
  'surcharge_binding',
  'placeholder_reference',
  'price_kind',
] as const

export type ValidationCheck = (typeof VALIDATION_CHECKS)[number]

export const VALIDATION_CODES = [
  'schema_invalid',
  'bom_negative_quantity',
  'limit_exceeded',
  'definition_too_large',
  'definition_too_deep',
  'expression_too_deep',
  'duplicate_key',
  'unknown_feature',
  'unknown_formula',
  'unknown_lookup',
  'unknown_rule',
  'unknown_bom_line',
  'lookup_kind_mismatch',
  'lookup_keyed_by_mismatch',
  'unknown_sku',
  'product_missing',
  'lookup_row_missing',
  'ambiguous_sku',
  'bom_unit_mismatch',
  'bom_unit_missing',
  'bom_sales_unit_quantity',
  'formula_cycle',
  'fixed_point_not_reached',
  'expr_feature_not_numeric',
  'expr_lookup_not_numeric',
  'default_not_an_option',
  'default_out_of_bounds',
  'default_off_step',
  'surcharge_rule_expected',
  'surcharge_multiple_lines',
  'placeholder_line_not_allowed',
  'placeholder_malformed',
  'price_kind_missing',
] as const

export type ValidationCode = (typeof VALIDATION_CODES)[number]

export type ValidationRefKind = 'feature' | 'formula' | 'lookup' | 'rule' | 'bom' | 'product' | 'priceKind'

export type ValidationRef = { kind: ValidationRefKind; key: string } | { kind: 'path'; path: string }

export type ValidationIssue = {
  check: ValidationCheck
  code: ValidationCode
  params: IssueParams
  refs: ValidationRef[]
}

export type ValidationReport = { ok: boolean; issues: ValidationIssue[] }

export const VALIDATION_CHECK_LABEL_KEYS: Record<ValidationCheck, string> = {
  schema: 'product_configurator.validation.checks.schema',
  limits: 'product_configurator.validation.checks.limits',
  lookup_coverage: 'product_configurator.validation.checks.lookup_coverage',
  duplicate_key: 'product_configurator.validation.checks.duplicate_key',
  referential_integrity: 'product_configurator.validation.checks.referential_integrity',
  ambiguous_sku: 'product_configurator.validation.checks.ambiguous_sku',
  bom_unit_mismatch: 'product_configurator.validation.checks.bom_unit_mismatch',
  formula_cycle: 'product_configurator.validation.checks.formula_cycle',
  fixed_point: 'product_configurator.validation.checks.fixed_point',
  numeric_expr_reference: 'product_configurator.validation.checks.numeric_expr_reference',
  default_valid: 'product_configurator.validation.checks.default_valid',
  surcharge_binding: 'product_configurator.validation.checks.surcharge_binding',
  placeholder_reference: 'product_configurator.validation.checks.placeholder_reference',
  price_kind: 'product_configurator.validation.checks.price_kind',
}

export const VALIDATION_MESSAGE_KEYS: Record<ValidationCode, string> = {
  schema_invalid: 'product_configurator.validation.codes.schema_invalid',
  bom_negative_quantity: 'product_configurator.validation.codes.bom_negative_quantity',
  limit_exceeded: 'product_configurator.validation.codes.limit_exceeded',
  definition_too_large: 'product_configurator.validation.codes.definition_too_large',
  definition_too_deep: 'product_configurator.validation.codes.definition_too_deep',
  expression_too_deep: 'product_configurator.validation.codes.expression_too_deep',
  duplicate_key: 'product_configurator.validation.codes.duplicate_key',
  unknown_feature: 'product_configurator.validation.codes.unknown_feature',
  unknown_formula: 'product_configurator.validation.codes.unknown_formula',
  unknown_lookup: 'product_configurator.validation.codes.unknown_lookup',
  unknown_rule: 'product_configurator.validation.codes.unknown_rule',
  unknown_bom_line: 'product_configurator.validation.codes.unknown_bom_line',
  lookup_kind_mismatch: 'product_configurator.validation.codes.lookup_kind_mismatch',
  lookup_keyed_by_mismatch: 'product_configurator.validation.codes.lookup_keyed_by_mismatch',
  unknown_sku: 'product_configurator.validation.codes.unknown_sku',
  product_missing: 'product_configurator.validation.codes.product_missing',
  lookup_row_missing: 'product_configurator.validation.codes.lookup_row_missing',
  ambiguous_sku: 'product_configurator.validation.codes.ambiguous_sku',
  bom_unit_mismatch: 'product_configurator.validation.codes.bom_unit_mismatch',
  bom_unit_missing: 'product_configurator.validation.codes.bom_unit_missing',
  bom_sales_unit_quantity: 'product_configurator.validation.codes.bom_sales_unit_quantity',
  formula_cycle: 'product_configurator.validation.codes.formula_cycle',
  fixed_point_not_reached: 'product_configurator.validation.codes.fixed_point_not_reached',
  expr_feature_not_numeric: 'product_configurator.validation.codes.expr_feature_not_numeric',
  expr_lookup_not_numeric: 'product_configurator.validation.codes.expr_lookup_not_numeric',
  default_not_an_option: 'product_configurator.validation.codes.default_not_an_option',
  default_out_of_bounds: 'product_configurator.validation.codes.default_out_of_bounds',
  default_off_step: 'product_configurator.validation.codes.default_off_step',
  surcharge_rule_expected: 'product_configurator.validation.codes.surcharge_rule_expected',
  surcharge_multiple_lines: 'product_configurator.validation.codes.surcharge_multiple_lines',
  placeholder_line_not_allowed: 'product_configurator.validation.codes.placeholder_line_not_allowed',
  placeholder_malformed: 'product_configurator.validation.codes.placeholder_malformed',
  price_kind_missing: 'product_configurator.validation.codes.price_kind_missing',
}
