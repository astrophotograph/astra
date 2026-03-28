import { useState, useCallback } from "preact/hooks";
import type { ManifestImage } from "../types";

interface Props {
  images: ManifestImage[];
  onImageClick: (index: number) => void;
  hasFilters: boolean;
}

function GalleryItem({
  image,
  index,
  onClick,
}: {
  image: ManifestImage;
  index: number;
  onClick: (idx: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);

  const handleLoad = useCallback(() => setLoaded(true), []);

  return (
    <div class="gallery-item" onClick={() => onClick(index)}>
      <img
        src={image.thumbPath}
        alt={image.summary || image.filename}
        loading="lazy"
        class={loaded ? "loaded" : "loading"}
        onLoad={handleLoad}
      />
      {image.favorite && <span class="fav-star">&#9733;</span>}
      <div class="overlay">
        <div class="caption-text">{image.summary || image.filename}</div>
        {image.catalogIds && image.catalogIds.length > 0 && (
          <div class="badges">
            {image.catalogIds.slice(0, 5).map((cat) => (
              <span key={cat} class="badge">
                {cat}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Gallery({ images, onImageClick, hasFilters }: Props) {
  if (images.length === 0) {
    return (
      <div class="gallery">
        <div class="no-results">
          {hasFilters
            ? "No images match your filters."
            : "No images yet."}
        </div>
      </div>
    );
  }

  return (
    <div class="gallery">
      {images.map((img, idx) => (
        <GalleryItem
          key={img.id}
          image={img}
          index={idx}
          onClick={onImageClick}
        />
      ))}
    </div>
  );
}
