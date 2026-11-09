import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { ModelVersionView } from '../../../../../../components/versions/ModelVersionView'

export default function ProductConfiguratorModelVersionPage({ params }: { params?: { id?: string; versionId?: string } }) {
  const id = params?.id
  const versionId = params?.versionId
  if (!id || !versionId) return null
  return (
    <Page>
      <PageBody>
        <ModelVersionView modelId={id} versionId={versionId} />
      </PageBody>
    </Page>
  )
}
