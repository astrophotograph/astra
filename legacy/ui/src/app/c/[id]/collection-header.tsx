import {Collection, User} from "@/lib/models"
import {EditCollectionForm} from "@/app/c/[id]/edit-collection-form"
import {AddImageForm} from "@/app/c/[id]/add-image-form"
import {DefaultBreadcrumb} from "@/components/default-breadcrumb"
import {isOwner} from "@/lib/aaa"

export async function CollectionHeader({name, user, collection}: {
  name?: string,
  user: User,
  collection: Collection
}) {
  const owner = await isOwner(user)

  if (!name) {
    name = collection.name
  }
  return (
    <div className={''}>
      <DefaultBreadcrumb user={user} pageName={name}/>
      <div className={'mt-2 md:flex md:items-center md:justify-between'}>
        <div className={'min-w-0 flex-1'}>
          <h2 className={'text-2xl/7 font-bold text-white sm:truncate sm:text-3xl sm:tracking-tight'}>
            {name}
          </h2>
        </div>
        <div className={'mt-4 flex gap-2 shrink-0 md:ml-4 md:mt-0'}>
          {owner && <AddImageForm collection={collection} user={user}/>}
          {owner && <EditCollectionForm collection={collection}/>}
          {/*<button type='button' className={'inline-flex items-center rounded-md bg-white/10 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-white/20'}>*/}
          {/*  Edit*/}
          {/*</button>*/}
        </div>
      </div>
      {/*<h2 className="text-2xl font-bold mb-6">*/}
      {/*  {name}*/}
      {/*</h2>*/}
      {/*<p>by me... have card to left hand side...#</p>*/}
    </div>
  )
}
