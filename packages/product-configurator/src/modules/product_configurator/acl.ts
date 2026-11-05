export const features = [
  { id: 'product_configurator.models.view', title: 'View configuration models', module: 'product_configurator' },
  {
    id: 'product_configurator.models.manage',
    title: 'Manage configuration models',
    module: 'product_configurator',
    dependsOn: ['product_configurator.models.view'],
  },
  { id: 'product_configurator.sessions.manage', title: 'Configure products on quotes', module: 'product_configurator' },
  { id: 'product_configurator.snapshots.view', title: 'View product configurations', module: 'product_configurator' },
]

export default features
