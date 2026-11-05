export const integrationMeta = {
  description: 'Product configurator integration coverage',
  dependsOnModules: ['catalog', 'sales', 'customer_groups', 'product_configurator'],
  // The module is registered only when OM_ENABLE_PRODUCT_CONFIGURATOR is set
  // (apps/mercato/src/modules.ts). dependsOnModules resolves against directories
  // on disk, so without this flag discovery would run the specs against an app
  // that never registered the module. Keep the values inline string literals:
  // discovery parses this file with a regex.
  requiredEnvVars: ['OM_ENABLE_PRODUCT_CONFIGURATOR'],
}

export default integrationMeta
