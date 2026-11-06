import type { InjectionColumnWidget } from '@open-mercato/shared/modules/widgets/injection'
import { ConfiguredLineCell } from '../../../components/order/ConfiguredLineColumn'

const widget: InjectionColumnWidget = {
  metadata: {
    id: 'product_configurator.injection.order-items-configured-column',
    title: 'Configured column',
    description: 'Marks configured order lines and links to their configuration details',
    features: ['product_configurator.snapshots.view', 'sales.orders.view'],
    priority: 40,
  },
  columns: [
    {
      id: 'product_configurator_configured',
      headerKey: 'product_configurator.orderItems.column',
      header: 'Configured',
      accessorKey: 'id',
      sortable: false,
      cell: ConfiguredLineCell,
    },
  ],
}

export default widget
