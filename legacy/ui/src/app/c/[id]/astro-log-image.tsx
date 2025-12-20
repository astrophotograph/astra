import {getImageUrl, Image} from "@/lib/models"
import Link from "next/link"

export function AstroLogImage({image, index}: { index: number, image: Image }) {
  console.log('AstroLogImage:', image)
  return (
    <div key={index} className="flex align-start">
      {/*<h4>{image.summary}</h4>*/}
      <div className={'mr-5'}>
        <Link href={`/i/${image.id}`}>
          <figure className="not-prose">
            <img className="object-contain max-w-64 max-h-64 aspect-auto rounded-xl mr-5 mb-5"
                 src={getImageUrl(image, '1000')}
                 alt={image.summary || ''}/>
            <figcaption className={'text-sm text-center mt-1 text-wrap'}>{image.summary}</figcaption>
          </figure>
        </Link>
      </div>
      <p className={'not-prose'}
         dangerouslySetInnerHTML={{__html: image.description_html}}
      />
    </div>
  )
}
