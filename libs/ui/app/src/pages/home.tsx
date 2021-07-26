import { Animation } from 'rsuite'
import {
  useAppConfig,
  useConfigStore,
  useContentsCollections
} from '@platyplus/react-rxdb-hasura'
import { DisplayName, useProfile } from '@platyplus/profile'
import { HeaderTitleWrapper } from '@platyplus/layout'

export const HomePage: React.FC<{ title?: string }> = ({
  title = 'Home Page'
}) => {
  const collections = useContentsCollections()
  const { document: profile } = useProfile()
  const hasChanges = useConfigStore((state) => !!state.countChanges())
  const config = useAppConfig()
  return (
    <HeaderTitleWrapper title={title}>
      <Animation.Fade in={!!profile}>
        {(props, ref) => (
          <div {...props}>
            <div>
              <h2>
                Welcome, <DisplayName profile={profile} />
              </h2>
              {config && JSON.stringify(config)}
              {hasChanges ? 'CHANGES' : 'NO CHANGES'}
              {[...collections.keys()].map((key) => (
                <div key={key}>{key}</div>
              ))}
            </div>
          </div>
        )}
      </Animation.Fade>
    </HeaderTitleWrapper>
  )
}

export default HomePage
