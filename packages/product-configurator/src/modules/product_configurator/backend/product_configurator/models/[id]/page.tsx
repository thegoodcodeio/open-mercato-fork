import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { ModelStudio } from '../../../../components/studio/ModelStudio'

export default function ModelStudioPage({ params }: { params?: { id?: string } }) {
  const id = params?.id
  if (!id) return null
  return (
    <Page>
      <PageBody>
        <ModelStudio modelId={id} />
      </PageBody>
    </Page>
  )
}
