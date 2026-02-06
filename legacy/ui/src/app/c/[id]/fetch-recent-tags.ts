'use server'

import {fetchRecentTagsByUser} from '@/lib/db'

export async function fetchRecentTags(userId: string): Promise<string[]> {
  return await fetchRecentTagsByUser(userId)
}