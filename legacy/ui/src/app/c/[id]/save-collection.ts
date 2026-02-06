'use server'

import {z} from "zod"
import {formSchema} from "@/app/c/[id]/collection-edit-type"
import {fetchCollection, fetchUser} from "@/lib/db"
import {isOwner} from "@/lib/aaa"
import {Collection} from "@/lib/database/models/Collection"

export async function saveCollection(values: z.infer<typeof formSchema>) {
  const collection = await fetchCollection(values.id)
  const user = await fetchUser(collection!.user_id!)
  if (!await isOwner(user!)) {
    return
  }

  // Prepare metadata with existing values plus new session_date
  const existingMetadata = collection!.metadata_ || {}
  const updatedMetadata = {
    ...existingMetadata,
    ...(values.session_date && { session_date: values.session_date }),
  }

  // Use Sequelize ORM for database compatibility (supports both SQLite and PostgreSQL)
  await Collection.update(
    {
      name: values.name,
      description: values.description,
      tags: values.tags?.trim() || null, // Convert empty string to null
      favorite: values.favorite || false,
      metadata_: updatedMetadata, // Sequelize model handles JSON serialization
    },
    {
      where: { id: values.id }
    }
  )
}
