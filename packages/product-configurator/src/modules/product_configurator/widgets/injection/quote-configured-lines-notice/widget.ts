import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import QuoteConfiguredLinesNoticeWidget from './widget.client'

const widget: InjectionWidgetModule = {
  metadata: {
    id: 'product_configurator.injection.quote-configured-lines-notice',
    title: 'Configured lines notice',
    description: 'Tells where the configured lines of the quote are edited',
    features: ['product_configurator.snapshots.view', 'sales.quotes.view'],
    priority: 40,
    enabled: true,
  },
  Widget: QuoteConfiguredLinesNoticeWidget,
}

export default widget
