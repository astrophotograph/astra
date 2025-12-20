import { NextResponse } from 'next/server'
import { initializeDatabase, ObservationSchedule, getDefaultUserId } from '@/lib/database'
import { auth } from '@clerk/nextjs/server'

export async function GET() {
  try {
    await initializeDatabase()
    
    const { userId } = auth()
    const defaultUserId = await getDefaultUserId()
    const currentUserId = userId || defaultUserId

    if (!currentUserId) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
    }

    const activeSchedule = await ObservationSchedule.findOne({
      where: { 
        user_id: currentUserId,
        is_active: true 
      }
    })

    if (!activeSchedule) {
      // If no active schedule, get the most recent one and make it active
      const latestSchedule = await ObservationSchedule.findOne({
        where: { user_id: currentUserId },
        order: [['updated_at', 'DESC']]
      })

      if (latestSchedule) {
        await latestSchedule.update({ is_active: true })
        return NextResponse.json(latestSchedule)
      }

      return NextResponse.json(null)
    }

    return NextResponse.json(activeSchedule)
  } catch (error) {
    console.error('Error fetching active schedule:', error)
    return NextResponse.json({ error: 'Failed to fetch active schedule' }, { status: 500 })
  }
}