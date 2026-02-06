import { backupSQLiteDatabase, getBackupConfig } from './backup';

// Global reference to the backup interval
let backupIntervalId: NodeJS.Timeout | null = null;

// Start periodic backups
export const startPeriodicBackups = (): void => {
  const config = getBackupConfig();
  
  if (!config.enabled) {
    console.log('Periodic backups are disabled');
    return;
  }

  // Stop existing interval if running
  stopPeriodicBackups();

  const intervalMs = config.intervalHours * 60 * 60 * 1000; // Convert hours to milliseconds
  
  console.log(`Starting periodic backups every ${config.intervalHours} hours`);
  
  backupIntervalId = setInterval(async () => {
    try {
      console.log('Running scheduled database backup...');
      await backupSQLiteDatabase();
    } catch (error) {
      console.error('Scheduled backup failed:', error);
    }
  }, intervalMs);

  // Also run an initial backup
  setTimeout(async () => {
    try {
      console.log('Running initial database backup...');
      await backupSQLiteDatabase();
    } catch (error) {
      console.error('Initial backup failed:', error);
    }
  }, 1000); // Run after 1 second to allow app initialization
};

// Stop periodic backups
export const stopPeriodicBackups = (): void => {
  if (backupIntervalId) {
    clearInterval(backupIntervalId);
    backupIntervalId = null;
    console.log('Periodic backups stopped');
  }
};

// Get backup status
export const getBackupStatus = (): { running: boolean; intervalHours: number; enabled: boolean } => {
  const config = getBackupConfig();
  return {
    running: backupIntervalId !== null,
    intervalHours: config.intervalHours,
    enabled: config.enabled,
  };
};