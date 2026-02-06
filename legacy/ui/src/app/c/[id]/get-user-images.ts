'use server'

import {fetchUserImages} from "@/lib/db"

export async function getUserImages(userId: string) {
  return await fetchUserImages(userId)
}