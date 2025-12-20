'use server'

import {z} from "zod"
import {isImageOwner} from "@/lib/aaa"
import {imageFormSchema} from "@/app/i/[id]/edit-types"
import {Image} from "@/lib/database"

export async function saveImage(values: z.infer<typeof imageFormSchema>) {
  if (!await isImageOwner(values.id)) {
    return
  }

  // Update image using Sequelize for cross-database compatibility
  await Image.update(
    {
      summary: values.summary,
      description: values.description,
      tags: values.tags,
      location: values.location,
      favorite: values.favorite || false
    },
    {
      where: { id: values.id }
    }
  )
}
