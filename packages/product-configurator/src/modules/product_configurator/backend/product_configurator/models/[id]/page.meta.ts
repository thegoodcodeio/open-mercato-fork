export const metadata = {
  requireAuth: true,
  requireFeatures: ['product_configurator.models.manage'],
  pageTitle: 'Model studio',
  pageTitleKey: 'product_configurator.studio.pageTitle',
  pageGroup: 'Product configurator',
  pageGroupKey: 'product_configurator.nav.group',
  navHidden: true,
  breadcrumb: [{ label: 'Models', labelKey: 'product_configurator.nav.models', href: '/backend/product_configurator/models' }],
}
