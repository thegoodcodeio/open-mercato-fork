import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { CatalogPriceRowService } from '@open-mercato/core/modules/catalog/services/catalogPriceRowService'
import type { ConfigurationModel } from '../data/entities'
import { createPublicationCatalogPort, validateForPublication, type ValidationReport } from './validation'

export async function validateModelDraft(
  em: EntityManager,
  container: AwilixContainer,
  model: ConfigurationModel,
): Promise<ValidationReport> {
  const catalogPriceRowService = container.resolve<CatalogPriceRowService>('catalogPriceRowService')
  return validateForPublication({
    definition: model.draftDefinition,
    productId: model.productId,
    catalog: createPublicationCatalogPort(catalogPriceRowService, em, {
      tenantId: model.tenantId,
      organizationId: model.organizationId,
    }),
  })
}
