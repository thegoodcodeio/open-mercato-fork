import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { SnapshotDetail } from '../../../../components/snapshots/SnapshotDetail'

export default function ConfigurationDetailsPage({ params }: { params?: { id?: string } }) {
  const id = params?.id
  if (!id) return null
  return (
    <Page>
      <PageBody>
        <SnapshotDetail snapshotId={id} />
      </PageBody>
    </Page>
  )
}
