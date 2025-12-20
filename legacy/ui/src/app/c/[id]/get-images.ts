'use server'

import {fetchCollectionImages} from "@/lib/db"

export async function getImages(id: string) {
  return await fetchCollectionImages(id)
}
