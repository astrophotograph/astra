import { NextResponse } from 'next/server';
import { fetchAstroObjects } from '@/lib/db';

export async function GET() {
  try {
    const objects = await fetchAstroObjects();
    return NextResponse.json(objects);
  } catch (error) {
    console.error('Error fetching astronomical objects:', error);
    return NextResponse.json(
      { error: 'Failed to fetch astronomical objects' },
      { status: 500 }
    );
  }
}
