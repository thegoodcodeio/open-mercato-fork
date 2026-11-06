import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { SessionConfigurator } from '../../../../components/configurator/session/SessionConfigurator'

export default function ConfigureProductPage({ params }: { params?: { sessionId?: string } }) {
  const sessionId = params?.sessionId
  if (!sessionId) return null
  return (
    <Page>
      <PageBody>
        <SessionConfigurator sessionId={sessionId} />
      </PageBody>
    </Page>
  )
}
