export const metadata = {
  requireAuth: true,
  requireFeatures: ['product_configurator.sessions.manage', 'sales.quotes.view'],
  pageTitle: 'Configure product',
  pageTitleKey: 'product_configurator.configurator.pageTitle',
  pageGroup: 'Product configurator',
  pageGroupKey: 'product_configurator.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'Quotes', labelKey: 'sales.quotes.list.title', href: '/backend/sales/quotes' },
    { label: 'Configure product', labelKey: 'product_configurator.configurator.pageTitle' },
  ],
}
