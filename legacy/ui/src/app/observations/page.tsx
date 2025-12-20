import {fetchAstroObservations, fetchUser} from "@/lib/db"
import {DefaultBreadcrumb} from "@/components/default-breadcrumb"
import {enrichCollections} from "@/components/enrichCollections"
import {ObservationLogCard} from "@/components/observation-log-card-server"
import {shouldUseSQLiteAutoLoginServer} from "@/lib/auth/server"
import {getDefaultUserId} from "@/lib/database"
import {currentUser} from "@clerk/nextjs/server"
import {redirect} from "next/navigation"
import {CreateCollectionDialog} from "@/components/create-collection-dialog"
import {isOwner} from "@/lib/aaa"

export default async function AstroLogPage() {
  let user

  if (shouldUseSQLiteAutoLoginServer()) {
    // SQLite mode: use default user
    const defaultUserId = await getDefaultUserId()
    if (!defaultUserId) {
      throw new Error('No default user found in SQLite database')
    }
    user = await fetchUser(defaultUserId)
  } else {
    // Non-SQLite mode: use Clerk authentication
    const clerkUser = await currentUser()
    if (!clerkUser) {
      redirect('/sign-in')
    }

    // Use the Clerk user ID or map it to your user system
    user = await fetchUser(clerkUser.id)

    // If user doesn't exist in your database, you might want to create them
    if (!user) {
      // Handle user creation or redirect to setup
      throw new Error('User not found in database')
    }
  }

  if (!user) {
    throw new Error('User not found')
  }

  const initialCollections = await fetchAstroObservations(user.id)
  const rawCollections = await enrichCollections(initialCollections)
  const collections = rawCollections.filter((item) => !item.favorite)
  
  // Check if user can edit collections
  const canEdit = await isOwner(user)

  const groupedCollections = collections.reduce((acc, collection) => {
    const date = new Date(collection.session_date!)
    const monthYear = date.toLocaleString('default', {month: 'long', year: 'numeric'})
    return {
      ...acc,
      [monthYear]: [...(acc[monthYear] || []), collection],
    }
  }, {} as Record<string, typeof collections>)

  // Sort month groups in reverse chronological order and sort collections within each month
  const sortedMonthEntries = Object.entries(groupedCollections)
    .sort(([monthYearA], [monthYearB]) => {
      const dateA = new Date(monthYearA + ' 1') // Add day to make it a valid date
      const dateB = new Date(monthYearB + ' 1')
      return dateB.getTime() - dateA.getTime()
    })
    .map(([monthYear, monthCollections]) => [
      monthYear,
      monthCollections.sort((a, b) => {
        const aDate = new Date(a.session_date!)
        const bDate = new Date(b.session_date!)
        return bDate.getTime() - aDate.getTime()
      })
    ] as [string, typeof monthCollections])

  return (
    <main className="container mx-auto py-8 flex-grow relative">
      <DefaultBreadcrumb user={user} pageName={'Astro Log'}/>
      <div className="flex justify-between items-center my-6">
        <h3 className="text-2xl font-semibold">Observation Log</h3>
        <CreateCollectionDialog defaultTemplate="astrolog" />
      </div>
      <p className={''}>
        Daily observation logs. Photos and some commentary. Most of these include just
        the raw, out-of-scope photos without any formal processing. At times, it may include a combination of
        out-of-scope and post-processed photos. But they will always be clearly marked.
      </p>
      {sortedMonthEntries.map(([monthYear, monthCollections]) => (
        <div key={monthYear} className={''}>
          <h4 className="text-xl font-semibold mt-8 mb-4 bg-slate-800 p-3 rounded sticky top-0 z-50">{monthYear}</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {monthCollections.map((collection) => (
              <div key={collection.id}>
                <ObservationLogCard 
                  collection={collection} 
                  size={'medium'}
                  user={user}
                  isEditable={canEdit && collection.user_id === user.id}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </main>
  )
}
