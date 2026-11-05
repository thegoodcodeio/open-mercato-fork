import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'product_configurator',
  title: 'Product Configurator',
  version: '0.1.0',
  description: 'Rule-based product configuration models, pricing and configured quote lines.',
  author: 'Open Mercato Team',
  license: 'MIT',
  requires: ['catalog', 'sales'],
}
