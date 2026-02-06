import {CollectionHeader} from "@/app/c/[id]/collection-header"
import {Collection, User} from "@/lib/models"
import {fetchCollectionImages} from "@/lib/db"
import {CollectionStats} from "@/app/c/[id]/collectionStats"
import {ImageThumbnail} from "@/app/c/[id]/imageThumbnail"
import {DragDropZone} from "@/app/c/[id]/drag-drop-zone"

export async function DefaultCollection({id, user, collection}: {id: string, user: User, collection: Collection}) {
  const images = await fetchCollectionImages(collection.id)

  return (
    <main className="container mx-auto py-8 flex-grow">
      <CollectionHeader user={user} collection={collection} />

      <p className="mb-6" dangerouslySetInnerHTML={{__html: collection.description_html}}></p>

      <CollectionStats collection_id={id}/>

      <DragDropZone collectionId={id} userId={user.id}>
        <div className="grid grid-cols-5 gap-4 mt-3">
          {images.map((image) => <ImageThumbnail key={image.id} checkCompleteImage={false} image={image}/>)}
        </div>
      </DragDropZone>
    </main>

  )
}
