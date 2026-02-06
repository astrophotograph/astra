import { NextRequest, NextResponse } from 'next/server';
import { backupSQLiteDatabase, listBackups, getBackupConfig } from '@/lib/database/backup';
import { getBackupStatus, startPeriodicBackups, stopPeriodicBackups } from '@/lib/database/scheduler';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    switch (action) {
      case 'list':
        const backups = await listBackups();
        return NextResponse.json({ files: backups });

      case 'status':
        const status = getBackupStatus();
        const config = getBackupConfig();
        return NextResponse.json({ 
          status,
          config: {
            enabled: config.enabled,
            intervalHours: config.intervalHours,
            maxBackups: config.maxBackups,
            backupPath: config.backupPath
          }
        });

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Backup API error:', error);
    return NextResponse.json(
      { error: 'Failed to process backup request' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'backup':
        const backupPath = await backupSQLiteDatabase();
        if (backupPath) {
          return NextResponse.json({ 
            success: true, 
            message: 'Backup created successfully',
            backupPath 
          });
        } else {
          return NextResponse.json({ 
            success: false, 
            message: 'Backup skipped (not using SQLite or backup disabled)' 
          });
        }

      case 'start':
        startPeriodicBackups();
        return NextResponse.json({ 
          success: true, 
          message: 'Periodic backups started' 
        });

      case 'stop':
        stopPeriodicBackups();
        return NextResponse.json({ 
          success: true, 
          message: 'Periodic backups stopped' 
        });

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Backup API error:', error);
    return NextResponse.json(
      { error: 'Failed to process backup request' },
      { status: 500 }
    );
  }
}