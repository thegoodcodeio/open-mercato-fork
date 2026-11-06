import { AdvancedJsonTab } from './AdvancedJsonTab'
import { BomTab } from './BomTab'
import { DependenciesTab } from './DependenciesTab'
import { FeaturesTab } from './FeaturesTab'
import { FormulasTab } from './FormulasTab'
import { LookupsTab } from './LookupsTab'
import { OverviewTab } from './OverviewTab'
import { RulesTab } from './RulesTab'
import { TestTab } from './TestTab'
import type { StudioTabDefinition, StudioTabId } from './types'

export const STUDIO_TABS: readonly StudioTabDefinition[] = [
  { id: 'overview', labelKey: 'product_configurator.studio.tabs.overview', fallbackLabel: 'Overview', component: OverviewTab },
  { id: 'features', labelKey: 'product_configurator.studio.tabs.features', fallbackLabel: 'Features', component: FeaturesTab },
  { id: 'formulas', labelKey: 'product_configurator.studio.tabs.formulas', fallbackLabel: 'Formulas', component: FormulasTab },
  { id: 'lookups', labelKey: 'product_configurator.studio.tabs.lookups', fallbackLabel: 'Lookups', component: LookupsTab },
  { id: 'rules', labelKey: 'product_configurator.studio.tabs.rules', fallbackLabel: 'Rules', component: RulesTab },
  { id: 'bom', labelKey: 'product_configurator.studio.tabs.bom', fallbackLabel: 'BOM', component: BomTab },
  {
    id: 'dependencies',
    labelKey: 'product_configurator.studio.tabs.dependencies',
    fallbackLabel: 'Dependencies',
    component: DependenciesTab,
  },
  { id: 'test', labelKey: 'product_configurator.studio.tabs.test', fallbackLabel: 'Test', component: TestTab },
  { id: 'advanced', labelKey: 'product_configurator.studio.tabs.advanced', fallbackLabel: 'Advanced (JSON)', component: AdvancedJsonTab },
]

export const STUDIO_TAB_IDS: readonly StudioTabId[] = STUDIO_TABS.map((tab) => tab.id)

export function isStudioTabId(value: string): value is StudioTabId {
  return STUDIO_TAB_IDS.some((id) => id === value)
}
