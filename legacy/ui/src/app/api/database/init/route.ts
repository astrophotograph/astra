import { NextResponse } from 'next/server';
import { ensureDatabaseInitialized } from '@/lib/database/init';

export async function GET() {
  try {
    await ensureDatabaseInitialized();
    return NextResponse.json({ 
      success: true, 
      message: 'Database initialized successfully' 
    });
  } catch (error) {
    console.error('Database initialization failed:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to initialize database',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

export async function POST() {
  return GET();
}
