'use server'

import {fetchAstroObjectByName, transformAstroObject} from "@/lib/db"


export async function fetchAstroObjectAction(name: string) {
  console.log('fetching object', name)
  const object = await fetchAstroObjectByName(name)

  if (!object) {
    return object
  }

  return transformAstroObject(object)
}

export type AstroObjectAction = Awaited<ReturnType<typeof fetchAstroObjectAction>>
