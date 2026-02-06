import { NextRequest, NextResponse } from 'next/server'
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

    const schedules = await ObservationSchedule.findAll({
      where: { user_id: currentUserId },
      order: [['updated_at', 'DESC']]
    })

    return NextResponse.json(schedules)
  } catch (error) {
    console.error('Error fetching schedules:', error)
    return NextResponse.json({ error: 'Failed to fetch schedules' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    await initializeDatabase()
    
    const { userId } = auth()
    const defaultUserId = await getDefaultUserId()
    const currentUserId = userId || defaultUserId

    if (!currentUserId) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { name, description, scheduled_date, location, items } = body

    if (!name) {
      return NextResponse.json({ error: 'Schedule name is required' }, { status: 400 })
    }

    // If this is the first schedule, make it active
    const existingSchedules = await ObservationSchedule.findAll({
      where: { user_id: currentUserId }
    })

    const schedule = await ObservationSchedule.create({
      user_id: currentUserId,
      name,
      description,
      scheduled_date,
      location,
      items: items || [],
      is_active: existingSchedules.length === 0
    })

    return NextResponse.json(schedule, { status: 201 })
  } catch (error) {
    console.error('Error creating schedule:', error)
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    await initializeDatabase()
    
    const { userId } = auth()
    const defaultUserId = await getDefaultUserId()
    const currentUserId = userId || defaultUserId

    if (!currentUserId) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { id, name, description, scheduled_date, location, items, is_active } = body

    if (!id) {
      return NextResponse.json({ error: 'Schedule ID is required' }, { status: 400 })
    }

    const schedule = await ObservationSchedule.findOne({
      where: { id, user_id: currentUserId }
    })

    if (!schedule) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
    }

    // If setting this schedule as active, deactivate all others
    if (is_active && !schedule.is_active) {
      await ObservationSchedule.update(
        { is_active: false },
        { where: { user_id: currentUserId } }
      )
    }

    await schedule.update({
      name: name ?? schedule.name,
      description: description ?? schedule.description,
      scheduled_date: scheduled_date ?? schedule.scheduled_date,
      location: location ?? schedule.location,
      items: items ?? schedule.items,
      is_active: is_active ?? schedule.is_active
    })

    return NextResponse.json(schedule)
  } catch (error) {
    console.error('Error updating schedule:', error)
    return NextResponse.json({ error: 'Failed to update schedule' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await initializeDatabase()
    
    const { userId } = auth()
    const defaultUserId = await getDefaultUserId()
    const currentUserId = userId || defaultUserId

    if (!currentUserId) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Schedule ID is required' }, { status: 400 })
    }

    const schedule = await ObservationSchedule.findOne({
      where: { id, user_id: currentUserId }
    })

    if (!schedule) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })
    }

    await schedule.destroy()

    // If we deleted the active schedule, activate another one
    if (schedule.is_active) {
      const remainingSchedule = await ObservationSchedule.findOne({
        where: { user_id: currentUserId },
        order: [['updated_at', 'DESC']]
      })
      
      if (remainingSchedule) {
        await remainingSchedule.update({ is_active: true })
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting schedule:', error)
    return NextResponse.json({ error: 'Failed to delete schedule' }, { status: 500 })
  }
}