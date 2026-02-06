'use server'

import {annotationFormSchema} from "@/app/i/[id]/edit-types"
import {z} from "zod"
import {isImageOwner} from "@/lib/aaa"
import {neon} from "@neondatabase/serverless"

export async function addAnnotation(values: z.infer<typeof annotationFormSchema>) {
  if (!await isImageOwner(values.id)) {
    return
  }

  // Connect to the Neon database
  const sql = neon(`${process.env.DATABASE_URL}`)

  const annotation = {
    type: 'custom',
    names: [values.name],
    pixelx: values.pixelx,
    pixely: values.pixely,
    radius: values.radius,
  }

  await sql`UPDATE image
               SET annotations = annotations::jsonb || '[${sql.unsafe(JSON.stringify(annotation))}]'
             WHERE id = ${values.id}`

}
