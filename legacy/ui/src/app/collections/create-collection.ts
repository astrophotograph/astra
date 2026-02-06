'use server'

import {nanoid} from 'nanoid'
import {fetchUser} from "@/lib/db"
import {isOwner} from "@/lib/aaa"
import {shouldUseSQLiteAutoLoginServer} from "@/lib/auth/server"
import {Collection, getDefaultUserId} from "@/lib/database"
import {currentUser} from "@clerk/nextjs/server"

export interface CreateCollectionInput {
  name: string
  description?: string
  template?: string
  visibility?: string
  tags?: string
  session_date?: string
}

export async function createCollection(input: CreateCollectionInput) {
  // Get authenticated user
  let user

  if (shouldUseSQLiteAutoLoginServer()) {
    const defaultUserId = await getDefaultUserId()
    if (!defaultUserId) {
      throw new Error('No default user found in SQLite database')
    }
    user = await fetchUser(defaultUserId)
  } else {
    const clerkUser = await currentUser()
    if (!clerkUser) {
      throw new Error('User not authenticated')
    }
    user = await fetchUser(clerkUser.id)
  }

  if (!user) {
    throw new Error('User not found')
  }

  if (!await isOwner(user)) {
    throw new Error('User not authorized to create collections')
  }

  // Generate unique ID for the collection
  const collectionId = nanoid()

  // Create metadata object with session_date if provided
  const metadata = input.session_date ? { session_date: input.session_date } : {}

  // Create new collection using Sequelize (works with both PostgreSQL and SQLite)
  const collection = await Collection.create({
    id: collectionId,
    user_id: user.id,
    name: input.name,
    description: input.description || null,
    template: input.template || null,
    visibility: input.visibility || 'private',
    tags: input.tags || null,
    metadata_: metadata,
    created_at: new Date(),
    updated_at: new Date(),
  })

  return { id: collection.id }
}
