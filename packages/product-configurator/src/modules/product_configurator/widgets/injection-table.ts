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
  'sales.document.detail.order:tabs': [
    {
      widgetId: 'product_configurator.injection.order-configurations-tab',
      kind: 'tab',
      groupLabel: 'product_configurator.orderTab.tabLabel',
      priority: 40,
    },
  ],
  'sales.document.detail.quote:details': {
    widgetId: 'product_configurator.injection.quote-configured-lines-notice',
    priority: 40,
  },
  'data-table:sales.order.items:columns': {
    widgetId: 'product_configurator.injection.order-items-configured-column',
    priority: 40,
  },
}

export default injectionTable
