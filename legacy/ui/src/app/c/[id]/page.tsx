import {fetchCollection, fetchUser} from "@/lib/db"
import {DefaultCollection} from "./default-collection"
import {AstroLogCollection} from "@/app/c/[id]/astro-log-collection"
import {MessierCollection} from "@/app/c/[id]/messier-collection"

export default async function CollectionPage({
                                               params,
                                             }: {
  params: Promise<{ id: string }>
}) {
  const {id} = await params
  const collection = await fetchCollection(id)
  const user = collection ? await fetchUser(collection.user_id!) : null

  if (!collection || !user) {
    return null
  }

  if (collection.template === 'astrolog') {
    return <AstroLogCollection user={user} collection={collection}/>
  }

  if (collection.template === 'messier') {
    return <MessierCollection id={id} user={user} collection={collection}/>
  }

  return (
    <DefaultCollection id={id} user={user} collection={collection}/>
  )
}
