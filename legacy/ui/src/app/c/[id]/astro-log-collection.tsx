import {Collection, User} from "@/lib/models"
import {fetchCollectionImages} from "@/lib/db"
import {CollectionHeader} from "@/app/c/[id]/collection-header"
import {AstroLogImage} from "@/app/c/[id]/astro-log-image"
import {YouTube} from "@/components/youtube"
import {MoonPhase} from "@/components/moon"
import {DragDropZone} from "@/app/c/[id]/drag-drop-zone"

export async function AstroLogCollection({user, collection}: { user: User, collection: Collection }) {
  const rawImage = await fetchCollectionImages(collection.id)
  const images = rawImage.filter((image) => !!image.description)
  const imagesNoDescription = rawImage.filter((image) => !image.description)
  const video_id = collection.metadata_?.video_id

  return (
    <main className="container mx-auto py-8 lg:px-20">
      <CollectionHeader name={`AstroLog - ${collection.session_date}`} user={user} collection={collection}/>

      <DragDropZone collectionId={collection.id} userId={user.id}>
        <div className={'flex flex-col lg:flex-row lg:space-x-5 space-y-5 lg:space-y-0'}>
          <article
            className="prose lg:prose-xl prose-invert prose-img:rounded-xl prose-figcaption:text-sm prose-figcaption:text-center prose-img:mt-0 flex-1"
            >
            <p dangerouslySetInnerHTML={{__html: collection.description_html}} />

            <div className="mt-6 space-y-5">
              {images.map((image, index) => (
                <AstroLogImage key={image.id} index={index} image={image}/>
              ))}
            </div>

            <div className="mt-6 gap-5 flex flex-wrap">
              {imagesNoDescription.map((image, index) => <AstroLogImage key={image.id} index={index} image={image}/>)}
            </div>

          </article>
          <div className={'lg:py-7 space-y-5 lg:space-y-7 w-full lg:w-80 flex-shrink-0 order-first lg:order-last'}>
            {video_id && <YouTube title={collection.name} id={video_id}/>}

            <div>
              {/* @ts-ignore */}
              <MoonPhase date={collection.session_date_as_date}/>
            </div>
          </div>
        </div>
      </DragDropZone>

      {/*<CollectionStats collection_id={id}/>*/}

    </main>

  )
}

// <Link key={image.id} href={`/i/${image.id}`}>{image.summary}</Link>
