import {Redis} from '@upstash/redis'
import {sequelize} from '@/lib/database'
import {getImageUrl} from '@/lib/models'

interface ImageResult {
  id: string;
  user_id: string;
  favorite: boolean;
  url?: string;
}

// Initialize Redis
const redis = new Redis({
  url: process.env['REDIS_KV_REST_API_URL'],
  token: process.env['REDIS_KV_REST_API_TOKEN']
})

export async function favoriteImage(collection_id: string) {
  // First, check if the URL is cached in Redis
  const cachedUrl = await redis.get<string | null>(`favorite_image:${collection_id}`)

  // If URL exists in Redis, return it immediately
  if (cachedUrl) {
    return cachedUrl
  }

  // If not in Redis, compute the URL using Sequelize for cross-database compatibility
  const results = await sequelize.query(
    `SELECT i.*
     FROM collectionimage ci
     JOIN images i ON ci.image_id = i.id
     WHERE ci.collection_id = :collection_id`,
    {
      replacements: { collection_id },
      type: sequelize.QueryTypes.SELECT,
    }
  ) as ImageResult[]
  let image: ImageResult | null = null

  const favorites = results.filter((item: ImageResult) => item.favorite)

  if (favorites.length > 0) {
    image = favorites[0]
  } else {
    if (results.length > 0) {
      image = results[0]
    }
  }

  // Determine the URL
  const imageUrl = !image
    ? '/ph/static/empty-collection.svg'
    : getImageUrl(image as any, '1000')

  // Store the URL in Redis for future requests
  // You can set an expiration time if needed (e.g., 3600 for 1 hour)
  await redis.set(`favorite_image:${collection_id}`, imageUrl, {ex: 3600})

  return imageUrl
}
