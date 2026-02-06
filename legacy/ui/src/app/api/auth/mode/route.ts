import { NextResponse } from 'next/server';
import { isSQLiteMode } from '@/lib/auth';

// GET - Check if we're in SQLite mode
export async function GET() {
  try {
    const sqliteMode = isSQLiteMode();
    return NextResponse.json({ isSQLite: sqliteMode });
  } catch (error) {
    console.error('Error checking auth mode:', error);
    return NextResponse.json({ error: 'Failed to check auth mode' }, { status: 500 });
  }
}
