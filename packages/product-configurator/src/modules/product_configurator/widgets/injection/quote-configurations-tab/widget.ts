import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import QuoteConfigurationsTabWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'product_configurator.injection.quote-configurations-tab',
    title: 'Configurations',
    description: 'Configure products on the quote and list its configured lines',
    features: ['product_configurator.snapshots.view', 'sales.quotes.view'],
    priority: 40,
    enabled: true,
  },
  Widget: QuoteConfigurationsTabWidget,
}

export default widget
