import {Collection} from "@/lib/models"
import {favoriteImage} from "@/lib/favoriteImage"

export async function enrichCollections(collections: Collection[]) {
  const response: Array<Collection> = []

  for (const collection of collections) {
    const favorite_image = await favoriteImage(collection.id)

    response.push({
      ...collection,
      favorite_image,
    })
  }

  return response
}
