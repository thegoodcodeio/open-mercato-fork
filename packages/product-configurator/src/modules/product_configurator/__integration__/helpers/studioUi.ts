import { expect, type Locator, type Page } from '@playwright/test'

export const MODELS_LIST_URL = '/backend/product_configurator/models'

export function studioUrl(modelId: string): string {
  return `${MODELS_LIST_URL}/${modelId}`
}

export function versionUrl(modelId: string, versionId: string): string {
  return `${MODELS_LIST_URL}/${modelId}/versions/${versionId}`
}

export async function openStudio(page: Page, modelId: string): Promise<void> {
  await page.goto(studioUrl(modelId), { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('model-studio')).toBeVisible({ timeout: 30_000 })
}

/** Opens a Radix select by its trigger and picks the option with this exact accessible name. */
export async function pickOption(page: Page, trigger: Locator, option: string): Promise<void> {
  await trigger.click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
}

export async function openTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

export function studioButton(page: Page, name: string): Locator {
  return page.getByTestId('studio-header').getByRole('button', { name, exact: true })
}

export async function saveDraft(page: Page): Promise<void> {
  await studioButton(page, 'Save draft').click()
  await expect(page.getByText('No unsaved changes.')).toBeVisible({ timeout: 15_000 })
}

export async function publish(page: Page): Promise<void> {
  await studioButton(page, 'Publish').click()
  await expect(page.getByTestId('studio-published-alert')).toBeVisible({ timeout: 30_000 })
}

/** Adds a "Feature value" condition row and points it at a feature and, when given, an option. */
export async function addFeatureCondition(page: Page, scope: Locator, feature: string, value?: string): Promise<void> {
  const rows = scope.getByTestId('condition-row')
  const index = await rows.count()
  await scope.getByRole('button', { name: 'Feature value', exact: true }).click()
  const row = rows.nth(index)
  await pickOption(page, row.getByRole('combobox', { name: 'Feature', exact: true }), feature)
  if (value !== undefined) await pickOption(page, row.getByRole('combobox', { name: 'Value', exact: true }), value)
}

/** Adds a "Calculated value" condition row: formula, ordering operator and number. */
export async function addCalculatedCondition(page: Page, scope: Locator, formula: string, operator: string, value: string): Promise<void> {
  const rows = scope.getByTestId('condition-row')
  const index = await rows.count()
  await scope.getByRole('button', { name: 'Calculated value', exact: true }).click()
  const row = rows.nth(index)
  await pickOption(page, row.getByRole('combobox', { name: 'Calculated value', exact: true }), formula)
  await pickOption(page, row.getByRole('combobox', { name: 'Operator', exact: true }), operator)
  await row.getByRole('textbox', { name: 'Value', exact: true }).fill(value)
}

export type OptionInput = { label: string; value: string; swatch?: string }

export async function addFeature(
  page: Page,
  feature: {
    label: string
    key: string
    type: 'Choice' | 'Yes/no' | 'Number' | 'Color'
    options?: OptionInput[]
    optionsFromLookup?: string
    number?: { min: string; max: string; step: string; unit: string }
    defaultValue: string
    inSummary?: boolean
    visibleWhen?: { feature: string; value: string }
  },
): Promise<void> {
  await page.getByRole('button', { name: 'Add feature', exact: true }).click()
  const editor = page.getByTestId('feature-editor')
  await expect(editor).toBeVisible()
  await editor.getByLabel('Name', { exact: true }).fill(feature.label)
  await editor.getByLabel('Key', { exact: true }).fill(feature.key)
  await editor.getByRole('radio', { name: feature.type, exact: true }).click()
  for (const [index, option] of (feature.options ?? []).entries()) {
    await editor.getByRole('button', { name: 'Add option', exact: true }).click()
    const row = editor.getByTestId('feature-option-row').nth(index)
    // Value first: leaving the label of an option without a value fills in a value suggested from the label.
    await row.getByRole('textbox', { name: 'Value', exact: true }).fill(option.value)
    await row.getByRole('textbox', { name: 'Option', exact: true }).fill(option.label)
    if (option.swatch) await row.getByRole('textbox', { name: 'Swatch', exact: true }).fill(option.swatch)
  }
  if (feature.optionsFromLookup) {
    await pickOption(page, editor.getByLabel('Options from a permitted lookup', { exact: true }), feature.optionsFromLookup)
  }
  if (feature.number) {
    await editor.getByLabel('Minimum', { exact: true }).fill(feature.number.min)
    await editor.getByLabel('Maximum', { exact: true }).fill(feature.number.max)
    await editor.getByLabel('Step', { exact: true }).fill(feature.number.step)
    await editor.getByLabel('Unit', { exact: true }).fill(feature.number.unit)
    await editor.getByLabel('Default', { exact: true }).fill(feature.defaultValue)
  } else {
    await pickOption(page, editor.getByLabel('Default', { exact: true }), feature.defaultValue)
  }
  if (feature.inSummary === false) await editor.getByRole('switch', { name: 'In summary', exact: true }).click()
  if (feature.visibleWhen) await addFeatureCondition(page, editor, feature.visibleWhen.feature, feature.visibleWhen.value)
  await editor.getByRole('button', { name: 'Save feature', exact: true }).click()
  await expect(editor).toHaveCount(0)
}

/** Opens a feature from the Features table and saves it under a new name, which leaves the draft dirty. */
export async function renameFeature(page: Page, from: string, to: string): Promise<void> {
  await openTab(page, 'Features')
  await page.getByTestId('studio-tab-panel-features').getByText(from, { exact: true }).click()
  const editor = page.getByTestId('feature-editor')
  await editor.getByLabel('Name', { exact: true }).fill(to)
  await editor.getByRole('button', { name: 'Save feature', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByTestId('studio-tab-panel-features').getByText(to, { exact: true })).toBeVisible()
}

/** A definition whose first feature has another label, as if someone else saved it meanwhile. */
export function withFirstFeatureLabel(definition: Record<string, unknown>, label: string): Record<string, unknown> {
  const features = Array.isArray(definition.features) ? definition.features : []
  return { ...definition, features: features.map((feature, index) => (index === 0 ? { ...feature, label } : feature)) }
}

export function firstFeatureLabel(definition: Record<string, unknown>): unknown {
  const [first] = Array.isArray(definition.features) ? definition.features : []
  return first && typeof first === 'object' && 'label' in first ? first.label : undefined
}
