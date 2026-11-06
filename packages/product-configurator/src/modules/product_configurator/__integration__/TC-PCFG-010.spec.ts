import { expect, test, type Page } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteCatalogProductIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  VERSIONS_PATH,
  createPriceKindFixture,
  createUnitProductFixture,
  deleteModelIfExists,
  deletePriceKindIfExists,
  readModel,
  uniqueSuffix,
} from './helpers/fixtures'
import { buildStudioReferenceDefinition, canonicalize, studioReferenceSkus } from './helpers/studioReference'
import {
  MODELS_LIST_URL,
  addCalculatedCondition,
  addFeature,
  addFeatureCondition,
  openTab,
  pickOption,
  publish,
  saveDraft,
} from './helpers/studioUi'

const CURRENCY = 'EUR'

async function pickFromCombobox(page: Page, placeholder: string, search: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: placeholder, exact: true }).fill(search)
  await page.getByRole('option', { name: new RegExp(`^${option}`) }).first().click()
}

async function createModelThroughDialog(page: Page, input: { title: string; modelKey: string; productTitle: string; priceKindTitle: string }) {
  await page.goto(MODELS_LIST_URL, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Create model' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Create configuration model')).toBeVisible()
  await dialog.locator('[data-crud-field-id="title"] input').fill(input.title)
  await dialog.locator('[data-crud-field-id="modelKey"] input').fill(input.modelKey)
  await pickFromCombobox(page, 'Search products', input.productTitle, input.productTitle)
  const currency = dialog.getByRole('combobox', { name: 'EUR', exact: true })
  await currency.fill(CURRENCY)
  await currency.press('Enter')
  // The price-kind search matches only a leading word of the title (pre-existing catalog behaviour, see TC-CAT-PRICES-001).
  await pickFromCombobox(page, 'Select a price kind', 'QA', input.priceKindTitle)
  await dialog.getByRole('button', { name: 'Create model' }).click()
  await expect(page.getByTestId('model-studio')).toBeVisible({ timeout: 30_000 })
  const match = new URL(page.url()).pathname.match(/models\/([0-9a-f-]{36})$/)
  expect(match, 'the create dialog opens the studio of the new model').toBeTruthy()
  return match?.[1] ?? ''
}

async function addFormula(page: Page, formula: { label: string; key: string; expression: string; unit: string; decimals: string }) {
  await page.getByRole('button', { name: 'Add formula', exact: true }).click()
  const editor = page.getByTestId('formula-editor')
  await editor.getByLabel('Name', { exact: true }).fill(formula.label)
  await editor.getByLabel('Key', { exact: true }).fill(formula.key)
  const expression = editor.getByRole('combobox', { name: 'Expression' })
  await expression.fill(formula.expression)
  await expression.press('Tab')
  await editor.getByLabel('Unit', { exact: true }).fill(formula.unit)
  await pickOption(page, editor.getByLabel('Decimals', { exact: true }), formula.decimals)
  await editor.getByRole('button', { name: 'Save formula', exact: true }).click()
  await expect(editor).toHaveCount(0)
}

async function startLookup(page: Page, lookup: { label: string; key: string; kind: 'Value' | 'Permitted options'; keyedBy: string }) {
  await page.getByRole('button', { name: 'Add lookup', exact: true }).click()
  const editor = page.getByTestId('lookup-editor')
  await editor.getByLabel('Name', { exact: true }).fill(lookup.label)
  await editor.getByLabel('Key', { exact: true }).fill(lookup.key)
  await editor.getByRole('radio', { name: lookup.kind, exact: true }).click()
  await pickOption(page, editor.getByLabel('Keyed by', { exact: true }), lookup.keyedBy)
  return editor
}

async function addValueLookup(page: Page, lookup: { label: string; key: string; keyedBy: string; rows: Array<[string, string]> }) {
  const editor = await startLookup(page, { ...lookup, kind: 'Value' })
  for (const [option, value] of lookup.rows) await editor.getByLabel(`Value for ${option}`, { exact: true }).fill(value)
  await expect(editor.getByTestId('lookup-coverage')).toContainText('has a row')
  await editor.getByRole('button', { name: 'Save lookup', exact: true }).click()
  await expect(editor).toHaveCount(0)
}

async function addPermittedLookup(
  page: Page,
  lookup: { label: string; key: string; keyedBy: string; values: string[]; rows: Array<[string, string[]]> },
) {
  const editor = await startLookup(page, { ...lookup, kind: 'Permitted options' })
  const newValue = editor.getByRole('textbox', { name: 'New allowed value', exact: true })
  for (const value of lookup.values) {
    await newValue.fill(value)
    await newValue.press('Enter')
  }
  for (const [option, values] of lookup.rows) {
    const group = editor.getByRole('group', { name: `Allowed values for ${option}`, exact: true })
    for (const value of values) await group.getByRole('button', { name: value, exact: true }).click()
  }
  await expect(editor.getByTestId('lookup-coverage')).toContainText('has a row')
  await editor.getByRole('button', { name: 'Save lookup', exact: true }).click()
  await expect(editor).toHaveCount(0)
}

type RuleInput = {
  label: string
  id: string
  order: string
  effect: 'Blocks' | 'Warns' | 'Sets a value' | 'Surcharge'
  conditions: Array<{ feature: string; value?: string } | { formula: string; operator: string; value: string }>
  message: string
  extraFeatureKeys?: string[]
  action?:
    | { kind: 'Set a value'; field: string; value: string }
    | { kind: 'Map values'; field: string; from: string; to: string }
    | { kind: 'Default from a permitted lookup'; field: string; lookup: string }
}

async function addRule(page: Page, rule: RuleInput) {
  await page.getByRole('button', { name: 'Add rule', exact: true }).click()
  const editor = page.getByTestId('rule-editor')
  await editor.getByLabel('Name', { exact: true }).fill(rule.label)
  await editor.getByLabel('Id', { exact: true }).fill(rule.id)
  await editor.getByLabel('Order', { exact: true }).fill(rule.order)
  await editor.getByRole('radio', { name: rule.effect, exact: true }).click()
  for (const condition of rule.conditions) {
    if ('formula' in condition) await addCalculatedCondition(page, editor, condition.formula, condition.operator, condition.value)
    else await addFeatureCondition(page, editor, condition.feature, condition.value)
  }
  if (rule.action) {
    const action = editor.getByTestId('rule-action-editor')
    await action.getByRole('radio', { name: rule.action.kind, exact: true }).click()
    await pickOption(page, action.getByRole('combobox', { name: 'Field to change' }), rule.action.field)
    if (rule.action.kind === 'Set a value') {
      await pickOption(page, action.getByRole('combobox', { name: 'Value', exact: true }), rule.action.value)
    } else if (rule.action.kind === 'Map values') {
      await action.getByRole('button', { name: 'Add row', exact: true }).click()
      const row = action.getByTestId('rule-map-row').first()
      await pickOption(page, row.getByRole('combobox', { name: 'Current value', exact: true }), rule.action.from)
      await pickOption(page, row.getByRole('combobox', { name: 'New value', exact: true }), rule.action.to)
    } else {
      await pickOption(page, action.getByRole('combobox', { name: 'Lookup' }), rule.action.lookup)
    }
  }
  await editor.getByLabel('Message', { exact: true }).fill(rule.message)
  for (const key of rule.extraFeatureKeys ?? []) {
    const tags = editor.getByTestId('rule-feature-keys').getByRole('textbox')
    await tags.fill(key)
    await tags.press('Enter')
  }
  await editor.getByRole('button', { name: 'Save rule', exact: true }).click()
  await expect(editor).toHaveCount(0)
}

type BomInput = {
  id: string
  order: string
  part: { sku: string; title: string } | { lookup: string }
  quantity: { number: string } | { formula: string }
  when?: { feature: string; value?: string }
  rule?: string
}

async function addBomLine(page: Page, line: BomInput) {
  await page.getByRole('button', { name: 'Add line', exact: true }).click()
  const editor = page.getByTestId('bom-line-editor')
  if ('sku' in line.part) {
    await editor.getByRole('radio', { name: 'Fixed SKU', exact: true }).click()
    await editor.getByLabel('SKU', { exact: true }).fill(line.part.sku)
    await expect(editor.getByTestId('bom-sku-title')).toHaveText(line.part.title, { timeout: 15_000 })
  } else {
    await editor.getByRole('radio', { name: 'SKU from lookup', exact: true }).click()
    await pickOption(page, editor.getByLabel('Value lookup with SKUs', { exact: true }), line.part.lookup)
  }
  if ('number' in line.quantity) {
    await editor.getByRole('radio', { name: 'Number', exact: true }).click()
    await editor.getByLabel('Quantity per configured product', { exact: true }).fill(line.quantity.number)
  } else {
    await editor.getByRole('radio', { name: 'Formula', exact: true }).click()
    await pickOption(page, editor.getByRole('combobox', { name: 'Formula', exact: true }), line.quantity.formula)
  }
  await expect(editor.getByTestId('bom-unit')).toContainText('pc', { timeout: 15_000 })
  if (line.when) await addFeatureCondition(page, editor, line.when.feature, line.when.value)
  if (line.rule) await pickOption(page, editor.getByLabel('Surcharge rule', { exact: true }), line.rule)
  await editor.getByLabel('Line id', { exact: true }).fill(line.id)
  await editor.getByLabel('Order', { exact: true }).fill(line.order)
  await editor.getByRole('button', { name: 'Save line', exact: true }).click()
  await expect(editor).toHaveCount(0)
}

test.describe('TC-PCFG-010: build the reference model in the studio', () => {
  test.use({ actionTimeout: 15_000 })

  test('creates a blank model in the dialog, builds every part through the tabs, publishes and matches the fixture', async ({ page, request }) => {
    test.setTimeout(600_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const skus = studioReferenceSkus(suffix)
    const productTitle = `QA PCFG 010 telehandler ${suffix}`
    const priceKindTitle = `QA PCFG 010 ${suffix}`
    const partTitles = new Map<string, string>()
    const productIds: string[] = []
    let priceKindId: string | null = null
    let modelId: string | null = null
    const partTitle = (sku: string) => partTitles.get(sku) ?? sku

    try {
      productIds.push(await createUnitProductFixture(request, token, { title: productTitle, sku: `QA-PCFG-010-${suffix}` }))
      for (const sku of Object.values(skus)) {
        partTitles.set(sku, `QA PCFG 010 part ${sku}`)
        productIds.push(await createUnitProductFixture(request, token, { title: partTitle(sku), sku }))
      }
      priceKindId = await createPriceKindFixture(request, token, CURRENCY, priceKindTitle)

      await login(page, 'admin')
      modelId = await createModelThroughDialog(page, {
        title: `QA PCFG 010 ${suffix}`,
        modelKey: `qa-pcfg-010-${suffix}`,
        productTitle,
        priceKindTitle,
      })

      await openTab(page, 'Features')
      await addFeature(page, {
        label: 'Boom length',
        key: 'boom',
        type: 'Choice',
        options: [{ label: '10 m', value: '10' }, { label: '14 m', value: '14' }],
        defaultValue: '10 m',
      })
      await addFeature(page, {
        label: 'Attachment',
        key: 'attachment',
        type: 'Choice',
        options: [{ label: 'Pallet forks', value: 'forks' }, { label: 'General-purpose bucket', value: 'bucket' }],
        defaultValue: 'Pallet forks',
      })
      await addFeature(page, {
        label: 'Cab',
        key: 'cab',
        type: 'Choice',
        options: [{ label: 'Open ROPS canopy', value: 'open' }, { label: 'Enclosed cab', value: 'enclosed' }],
        defaultValue: 'Open ROPS canopy',
      })
      await addFeature(page, {
        label: 'Cab heater',
        key: 'heater',
        type: 'Yes/no',
        defaultValue: 'No',
        visibleWhen: { feature: 'Cab (cab)', value: 'Enclosed cab' },
      })
      await addFeature(page, { label: 'Auxiliary hydraulics', key: 'aux_hydraulics', type: 'Yes/no', defaultValue: 'No' })

      await openTab(page, 'Lookups')
      await addValueLookup(page, {
        label: 'Boom parts',
        key: 'boom_skus',
        keyedBy: 'Boom length (boom)',
        rows: [['10 m', skus.boom10], ['14 m', skus.boom14]],
      })
      await addValueLookup(page, {
        label: 'Rated load by boom',
        key: 'rated_load',
        keyedBy: 'Boom length (boom)',
        rows: [['10 m', '3500'], ['14 m', '3000']],
      })
      await addPermittedLookup(page, {
        label: 'Paint by cab',
        key: 'paint_by_cab',
        keyedBy: 'Cab (cab)',
        values: ['yellow', 'green'],
        rows: [['Open ROPS canopy', ['yellow', 'green']], ['Enclosed cab', ['yellow']]],
      })

      await openTab(page, 'Features')
      await addFeature(page, {
        label: 'Paint',
        key: 'paint',
        type: 'Color',
        options: [
          { label: 'Signal yellow', value: 'yellow', swatch: '#F2B705' },
          { label: 'Farm green', value: 'green', swatch: '#2E6B30' },
        ],
        optionsFromLookup: 'Paint by cab (paint_by_cab)',
        defaultValue: 'Signal yellow',
        inSummary: false,
      })
      await addFeature(page, {
        label: 'Extra outreach',
        key: 'outreach',
        type: 'Number',
        number: { min: '0', max: '4', step: '0.5', unit: 'm' },
        defaultValue: '0',
      })

      await openTab(page, 'Formulas')
      await addFormula(page, { label: 'Hydraulic hose length', key: 'hose_m', expression: 'feature.boom * 2 + 0.5', unit: 'm', decimals: '1' })
      await addFormula(page, { label: 'Rated load', key: 'rated_load_kg', expression: 'lookup.rated_load', unit: 'kg', decimals: '0' })

      await openTab(page, 'Rules')
      await addRule(page, {
        label: 'Long hose runs need auxiliary hydraulics',
        id: 'F-LONG-BOOM-HYDRAULICS',
        order: '10',
        effect: 'Sets a value',
        conditions: [{ formula: 'Hydraulic hose length (hose_m)', operator: '>', value: '25' }],
        action: { kind: 'Set a value', field: 'Auxiliary hydraulics (aux_hydraulics)', value: 'Yes' },
        message: 'A boom with {formula.hose_m} m of hose comes with auxiliary hydraulics.',
        extraFeatureKeys: ['aux_hydraulics'],
      })
      await addRule(page, {
        label: 'Reduced rated load with a bucket',
        id: 'W-BUCKET-LOAD',
        order: '20',
        effect: 'Warns',
        conditions: [
          { feature: 'Attachment (attachment)', value: 'General-purpose bucket' },
          { formula: 'Rated load (rated_load_kg)', operator: '<', value: '3600' },
        ],
        message: 'The rated load with the {feature.attachment} on this boom is {lookup.rated_load} kg.',
      })
      await addRule(page, {
        label: 'A bucket needs the enclosed cab',
        id: 'E-BUCKET-OPEN-CAB',
        order: '30',
        effect: 'Blocks',
        conditions: [
          { feature: 'Attachment (attachment)', value: 'General-purpose bucket' },
          { feature: 'Cab (cab)', value: 'Open ROPS canopy' },
        ],
        message: 'The bucket needs the enclosed cab.',
      })
      await addRule(page, {
        label: 'Cab heater surcharge',
        id: 'S-HEATER',
        order: '40',
        effect: 'Surcharge',
        conditions: [{ feature: 'Cab heater (heater)', value: 'Yes' }],
        message: 'The cab heater adds {line.heater.total}.',
      })
      await addRule(page, {
        label: 'Enclosed cabs take the permitted paint',
        id: 'F-ENCLOSED-PAINT',
        order: '50',
        effect: 'Sets a value',
        conditions: [{ feature: 'Cab (cab)', value: 'Enclosed cab' }],
        action: { kind: 'Default from a permitted lookup', field: 'Paint (paint)', lookup: 'Paint by cab (paint_by_cab)' },
        message: 'Enclosed cabs come in {feature.paint}.',
      })
      await addRule(page, {
        label: 'Buckets go on the short boom',
        id: 'F-BUCKET-BOOM',
        order: '60',
        effect: 'Sets a value',
        conditions: [{ feature: 'Attachment (attachment)', value: 'General-purpose bucket' }],
        action: { kind: 'Map values', field: 'Boom length (boom)', from: '14 m', to: '10 m' },
        message: 'A bucket fits the 10 m boom only.',
      })

      await openTab(page, 'BOM')
      await addBomLine(page, { id: 'chassis', order: '10', part: { sku: skus.chassis, title: partTitle(skus.chassis) }, quantity: { number: '1' } })
      await addBomLine(page, { id: 'boom', order: '20', part: { lookup: 'Boom parts (boom_skus)' }, quantity: { number: '1' } })
      await addBomLine(page, {
        id: 'heater',
        order: '30',
        part: { sku: skus.heater, title: partTitle(skus.heater) },
        quantity: { number: '1' },
        when: { feature: 'Cab heater (heater)', value: 'Yes' },
        rule: 'Cab heater surcharge (S-HEATER)',
      })
      await addBomLine(page, {
        id: 'aux_hose',
        order: '40',
        part: { sku: skus.hose, title: partTitle(skus.hose) },
        quantity: { formula: 'Hydraulic hose length (hose_m)' },
        when: { feature: 'Auxiliary hydraulics (aux_hydraulics)', value: 'Yes' },
      })

      await saveDraft(page)
      const expected = canonicalize(buildStudioReferenceDefinition({ priceKindId, currencyCode: CURRENCY, skus }))
      expect(canonicalize((await readModel(request, token, modelId)).draftDefinition)).toEqual(expected)

      await publish(page)
      await expect(page.getByText('Published v1', { exact: true })).toBeVisible()
      const saved = await readModel(request, token, modelId)
      expect(saved.hasUnpublishedChanges).toBe(false)
      const versionResponse = await apiRequest(request, 'GET', `${VERSIONS_PATH}?id=${saved.latestVersion?.id}`, { token })
      expect(versionResponse.status()).toBe(200)
      const version = await readJsonSafe<{ version: number; definition: unknown }>(versionResponse)
      expect(version?.version).toBe(1)
      expect(canonicalize(version?.definition)).toEqual(expected)
    } finally {
      await deleteModelIfExists(request, token, modelId)
      await deletePriceKindIfExists(request, token, priceKindId)
      for (const id of productIds) await deleteCatalogProductIfExists(request, token, id)
    }
  })
})
