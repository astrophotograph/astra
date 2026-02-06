import {fetchImage, fetchUser} from "@/lib/db"
import {ImageViewer} from "@/components/image-viewer"
import {DefaultBreadcrumb} from "@/components/default-breadcrumb"
import {isOwner} from "@/lib/aaa"
import {EditImageForm} from "@/app/i/[id]/edit-image-form"

export default async function ImagePage({params}: { params: Promise<{ id: string }> }) {
  // include optional query parameter for collection so we can make breadcrumb better
  const {id} = await params
  const image = await fetchImage(id)

  console.log('ImagePage:', image)
  if (!image) {
    return null
  }

  const user = await fetchUser(image.user_id!)
  const owner = await isOwner(user!)

  return (
    <main className="container mx-auto py-8 flex-grow">
      <DefaultBreadcrumb user={user!} pageName={image.summary!}/>
      <div className={'relative'}>
        <div className={'absolute top-0 right-0 z-50'}>
          {owner && (<EditImageForm image={image}/>)}
        </div>
        <ImageViewer user={user!} image={image}/>
      </div>
    </main>
  )
}
