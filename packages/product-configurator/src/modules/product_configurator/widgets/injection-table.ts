import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

export const injectionTable: ModuleInjectionTable = {
  'sales.document.detail.quote:tabs': [
    {
      widgetId: 'product_configurator.injection.quote-configurations-tab',
      kind: 'tab',
      groupLabel: 'product_configurator.quoteTab.tabLabel',
      priority: 40,
    },
  ],
}

export default injectionTable
