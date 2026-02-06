import {NextRequest, NextResponse} from 'next/server'
import {
  createAstronomyTodoItem,
  deleteAstronomyTodoItem,
  fetchAstronomyTodoItems,
  syncAstronomyTodoItems,
  updateAstronomyTodoItem,
} from '@/lib/db'
import { getAuthenticatedUser } from '@/lib/auth'

// GET - Fetch all astronomy todo items for the current user
export async function GET() {
  try {
    const { user, isAuthenticated } = await getAuthenticatedUser();

    if (!isAuthenticated || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const todoItems = await fetchAstronomyTodoItems(user.id);
    return NextResponse.json(todoItems);
  } catch (error) {
    console.error('Error fetching astronomy todo items:', error);
    return NextResponse.json({ error: 'Failed to fetch astronomy todo items' }, { status: 500 });
  }
}

// POST - Create a new astronomy todo item
export async function POST(req: NextRequest) {
  try {
    const { user, isAuthenticated } = await getAuthenticatedUser();

    if (!isAuthenticated || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const todoItem = await req.json();
    const createdItem = await createAstronomyTodoItem(user.id, todoItem);
    return NextResponse.json(createdItem, { status: 201 });
  } catch (error) {
    console.error('Error creating astronomy todo item:', error);
    return NextResponse.json({ error: 'Failed to create astronomy todo item' }, { status: 500 });
  }
}

// PUT - Update an existing astronomy todo item
export async function PUT(req: NextRequest) {
  try {
    const { user, isAuthenticated } = await getAuthenticatedUser();

    if (!isAuthenticated || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const todoItem = await req.json();
    const updatedItem = await updateAstronomyTodoItem(user.id, todoItem);
    return NextResponse.json(updatedItem);
  } catch (error) {
    console.error('Error updating astronomy todo item:', error);
    return NextResponse.json({ error: 'Failed to update astronomy todo item' }, { status: 500 });
  }
}

// DELETE - Delete an astronomy todo item
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const itemId = searchParams.get('id');

    if (!itemId) {
      return NextResponse.json({ error: 'Item ID is required' }, { status: 400 });
    }

    const { user, isAuthenticated } = await getAuthenticatedUser();

    if (!isAuthenticated || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const success = await deleteAstronomyTodoItem(user.id, itemId);

    if (success) {
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }
  } catch (error) {
    console.error('Error deleting astronomy todo item:', error);
    return NextResponse.json({ error: 'Failed to delete astronomy todo item' }, { status: 500 });
  }
}

// PATCH - Sync multiple astronomy todo items
export async function PATCH(req: NextRequest) {
  try {
    const { user, isAuthenticated } = await getAuthenticatedUser();
    console.log('user:', user, isAuthenticated)

    if (!isAuthenticated || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { items } = await req.json();
    const syncedItems = await syncAstronomyTodoItems(user.id, items);
    return NextResponse.json(syncedItems);
  } catch (error) {
    console.error('Error syncing astronomy todo items:', error);
    return NextResponse.json({ error: 'Failed to sync astronomy todo items' }, { status: 500 });
  }
}
