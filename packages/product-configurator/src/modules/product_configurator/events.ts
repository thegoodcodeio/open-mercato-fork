import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'product_configurator.model.created', label: 'Configuration Model Created', entity: 'model', category: 'crud' },
  { id: 'product_configurator.model.updated', label: 'Configuration Model Updated', entity: 'model', category: 'crud' },
  { id: 'product_configurator.model.deleted', label: 'Configuration Model Deleted', entity: 'model', category: 'crud' },
  {
    id: 'product_configurator.model_version.published',
    label: 'Configuration Model Version Published',
    entity: 'model_version',
    category: 'lifecycle',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'product_configurator', events })
export const emitProductConfiguratorEvent = eventsConfig.emit
export type ProductConfiguratorEventId = (typeof events)[number]['id']
export default eventsConfig
