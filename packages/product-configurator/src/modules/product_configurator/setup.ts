import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { seedReferenceModel } from './lib/seeds'

export const setup: ModuleSetupConfig = {
  seedExamples: async (ctx) => {
    await seedReferenceModel(ctx.em, ctx.container, { tenantId: ctx.tenantId, organizationId: ctx.organizationId })
  },

  defaultRoleFeatures: {
    superadmin: ['product_configurator.*'],
    admin: ['product_configurator.*'],
    employee: [
      'product_configurator.sessions.manage',
      'product_configurator.models.view',
      'product_configurator.snapshots.view',
    ],
  },
}

export default setup
