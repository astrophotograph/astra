import { NextRequest, NextResponse } from 'next/server';
import { restoreSQLiteDatabase } from '@/lib/database/backup';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { backupFileName } = body;

    if (!backupFileName) {
      return NextResponse.json(
        { error: 'Backup filename is required' },
        { status: 400 }
      );
    }

    // Validate filename to prevent path traversal
    const sanitizedFileName = path.basename(backupFileName);
    if (sanitizedFileName !== backupFileName) {
      return NextResponse.json(
        { error: 'Invalid backup filename' },
        { status: 400 }
      );
    }

    const backupPath = path.join(process.env.BACKUP_PATH || './backups', sanitizedFileName);
    
    await restoreSQLiteDatabase(backupPath);

    return NextResponse.json({
      success: true,
      message: `Database restored from ${sanitizedFileName}`
    });
  } catch (error) {
    console.error('Restore API error:', error);
    return NextResponse.json(
      { error: 'Failed to restore database' },
      { status: 500 }
    );
  }
}