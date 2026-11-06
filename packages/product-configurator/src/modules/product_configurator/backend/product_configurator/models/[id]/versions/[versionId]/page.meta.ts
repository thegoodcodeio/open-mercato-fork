export const metadata = {
  requireAuth: true,
  requireFeatures: ['product_configurator.models.view'],
  pageTitle: 'Published version',
  pageTitleKey: 'product_configurator.versions.pageTitle',
  pageGroup: 'Product configurator',
  pageGroupKey: 'product_configurator.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'Configuration models', labelKey: 'product_configurator.models.list.title', href: '/backend/product_configurator/models' },
    { label: 'Published version', labelKey: 'product_configurator.versions.pageTitle' },
  ],
}
