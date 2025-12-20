'use server'

import {Collection, Image} from '@/lib/database'
import {fetchCollection, fetchImage, fetchUser} from "@/lib/db"
import {isOwner} from "@/lib/aaa"

export async function addImageToCollection(collectionId: string, imageId: string) {
  const collection = await fetchCollection(collectionId)
  const image = await fetchImage(imageId)

  if (!collection) {
    throw new Error('Collection not found')
  }
  if (!image) {
    throw new Error(`Image not found ${imageId}`)
  }

  const user = await fetchUser(collection.user_id!)
  if (!await isOwner(user!)) {
    throw new Error('Not authorized to modify this collection')
  }

  // Use Sequelize many-to-many association to add image to collection
  const collectionModel = await Collection.findByPk(collectionId)
  const imageModel = await Image.findByPk(imageId)

  if (!collectionModel) {
    throw new Error('Collection not found in database')
  }
  if (!imageModel) {
    throw new Error('Image not found in database')
  }

  // Add the image to the collection (Sequelize handles duplicate prevention)
  await collectionModel.addImage(imageModel)
}
