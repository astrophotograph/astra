import Image from 'next/image'
import { getImageUrl, Image as ImageType } from '@/lib/models'
import { getPlaceholderDataUrl } from '@/lib/db'

interface OptimizedImageProps {
  image: ImageType
  size?: '500' | '1000' | 'full'
  className?: string
  alt?: string
  width?: number
  height?: number
  priority?: boolean
}

export function OptimizedImage({
  image,
  size = '1000',
  className,
  alt,
  width,
  height,
  priority = false
}: OptimizedImageProps) {
  const src = getImageUrl(image, size)
  const placeholder = getPlaceholderDataUrl(image)
  const altText = alt || image.summary || image.name || 'Image'
  
  // Use metadata dimensions if width/height not provided
  const imageWidth = width || image.metadata_?.width || 800
  const imageHeight = height || image.metadata_?.height || 600

  return (
    <Image
      src={src}
      alt={altText}
      width={imageWidth}
      height={imageHeight}
      className={className}
      priority={priority}
      placeholder={placeholder ? 'blur' : 'empty'}
      blurDataURL={placeholder || undefined}
      sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
    />
  )
}

// Component for thumbnail grid usage
export function OptimizedThumbnail({
  image,
  className = "object-cover w-full h-full",
  ...props
}: Omit<OptimizedImageProps, 'size'>) {
  return (
    <OptimizedImage
      image={image}
      size="500"
      className={className}
      {...props}
    />
  )
}

// Component for medium-sized displays
export function OptimizedMediumImage({
  image,
  className = "object-contain max-w-full max-h-full",
  ...props
}: Omit<OptimizedImageProps, 'size'>) {
  return (
    <OptimizedImage
      image={image}
      size="1000"
      className={className}
      {...props}
    />
  )
}