import {Card, CardContent} from "@/components/ui/card"
import type {Collection, User} from "@/lib/models"
import {cx} from "class-variance-authority"
import {fetchCollectionImageCount} from "@/lib/db"
import Link from "next/link"
import {ObservationLogCardClient} from "./observation-log-card"

export async function ObservationLogCard({collection, defaultPath, size = 'small', user, isEditable}: {
  size?: 'small' | 'medium',
  collection: Collection | null,
  defaultPath?: string,
  user?: User | null,
  isEditable?: boolean
}) {
  if (!collection) {
    return (
      <Link href={defaultPath || '#'}>
        <Card className={cx('pt-0 overflow-hidden', size == 'small' ? 'h-80' : 'h-96')}>
          <CardContent className={'p-0'}>
            <img src={'/ph/static/placeholder-more.svg'} className={'rounded-lg'}/>
          </CardContent>
        </Card>
      </Link>
    )
  }

  const imageCount = await fetchCollectionImageCount(collection.id!)

  return (
    <ObservationLogCardClient
      collection={collection}
      user={user || null}
      imageCount={imageCount}
      size={size}
      isEditable={isEditable || false}
    />
  )
}