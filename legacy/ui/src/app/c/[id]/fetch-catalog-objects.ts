'use server'

import {fetchCatalogObjects, transformAstroObject} from "@/lib/db"

export async function getCatalogObjects(catalog: string) {
  const objects = await fetchCatalogObjects(catalog)

  return objects.map((data) => transformAstroObject(data))
}
