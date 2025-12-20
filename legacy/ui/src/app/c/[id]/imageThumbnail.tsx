import {getImageUrl, Image} from "@/lib/models"

export function ImageThumbnail({image, checkCompleteImage}: { checkCompleteImage: boolean, image: Image }) {
  return (
    <a href={`/i/${image.id}`}>
      <div
        className="square aspect-square bg-neutral-800 border border-neutral-700 rounded-lg flex items-center justify-center overflow-hidden group relative">
        <div className="absolute left-0 bottom-0 z-50">{image.short_name}</div>
        {/*{% if image.id %}*/}
        <img className="object-cover absolute min-w-full min-h-full "
             src={getImageUrl(image, '500')}
             alt={image.summary || ''}/>
        {checkCompleteImage && (
          <div className="absolute right-0 bottom-0">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="green" className="size-6">
              <path fill-rule="evenodd"
                    d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
                    clip-rule="evenodd"/>
            </svg>
          </div>
        )}
        {/*{% endif %}*/}
        <div
          className="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-50 transition-opacity duration-300">
        </div>
        <span
          className="text-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300 text-pretty text-center z-50 flex flex-col">
        <span className="font-bold">{image.name || image.summary}</span>
          {image.common_name && (
            <span className="text-pretty text-center mt-1.5">{image.common_name}</span>
          )}
    </span>
      </div>
    </a>
  )
}
