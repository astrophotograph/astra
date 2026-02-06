import {User} from "./models"
import {auth} from "@clerk/nextjs/server"
import {fetchImage, fetchUser} from "@/lib/db"
import {shouldUseSQLiteAutoLoginServer} from '@/lib/auth/server'

export async function isOwner(user: User) {
  // In SQLite mode, always return true (single user system)
  if (shouldUseSQLiteAutoLoginServer()) {
    return true
  }

  const {userId} = await auth()
  return user.metadata_['clerk:user_id'] === userId
}

export async function isImageOwner(id: string) {
  // In SQLite mode, always return true (single user system)
  if (shouldUseSQLiteAutoLoginServer()) {
    return true
  }

  const image = await fetchImage(id)
  const user = await fetchUser(image!.user_id!)

  return await isOwner(user!)
}
