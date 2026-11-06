export const metadata = {
  requireAuth: true,
  requireFeatures: ['product_configurator.snapshots.view'],
  pageTitle: 'Configuration details',
  pageTitleKey: 'product_configurator.snapshot.pageTitle',
  pageGroup: 'Product configurator',
  pageGroupKey: 'product_configurator.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'Quotes', labelKey: 'sales.quotes.list.title', href: '/backend/sales/quotes' },
    { label: 'Configuration details', labelKey: 'product_configurator.snapshot.pageTitle' },
  ],
}
