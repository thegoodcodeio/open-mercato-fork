import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import OrderConfigurationsTabWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'product_configurator.injection.order-configurations-tab',
    title: 'Configurations',
    description: 'Configured lines of the order with their configuration details',
    features: ['product_configurator.snapshots.view', 'sales.orders.view'],
    priority: 40,
    enabled: true,
  },
  Widget: OrderConfigurationsTabWidget,
}

export default widget
