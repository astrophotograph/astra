import { promises as fs } from 'fs';
import path from 'path';
import { getDatabaseConfig } from './config';

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  maxBackups: number;
  backupPath: string;
}

// Get backup configuration from environment variables
export const getBackupConfig = (): BackupConfig => {
  return {
    enabled: process.env.BACKUP_ENABLED === 'true' || false,
    intervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS || '24'),
    maxBackups: parseInt(process.env.BACKUP_MAX_COUNT || '7'),
    backupPath: process.env.BACKUP_PATH || './backups',
  };
};

// Generate timestamp for backup filename
const getTimestamp = (): string => {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + 
         now.toTimeString().split(' ')[0].replace(/:/g, '-');
};

// Create backup directory if it doesn't exist
const ensureBackupDirectory = async (backupPath: string): Promise<void> => {
  try {
    await fs.mkdir(backupPath, { recursive: true });
  } catch (error) {
    console.error('Failed to create backup directory:', error);
    throw error;
  }
};

// Clean up old backups based on maxBackups setting
const cleanupOldBackups = async (backupPath: string, maxBackups: number): Promise<void> => {
  try {
    const files = await fs.readdir(backupPath);
    const backupFiles = files
      .filter(file => file.endsWith('.sqlite'))
      .map(file => ({
        name: file,
        path: path.join(backupPath, file),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .reverse(); // Most recent first

    if (backupFiles.length > maxBackups) {
      const filesToDelete = backupFiles.slice(maxBackups);
      for (const file of filesToDelete) {
        await fs.unlink(file.path);
        console.log(`Deleted old backup: ${file.name}`);
      }
    }
  } catch (error) {
    console.error('Failed to cleanup old backups:', error);
  }
};

// Perform SQLite database backup
export const backupSQLiteDatabase = async (): Promise<string | null> => {
  const dbConfig = getDatabaseConfig();
  
  // Only backup if using SQLite
  if (dbConfig.dialect !== 'sqlite' || !dbConfig.storage) {
    console.log('Backup skipped: Not using SQLite database');
    return null;
  }

  const backupConfig = getBackupConfig();
  
  if (!backupConfig.enabled) {
    console.log('Backup skipped: Backup is disabled');
    return null;
  }

  try {
    const sourcePath = dbConfig.storage;
    const timestamp = getTimestamp();
    const backupFileName = `database_${timestamp}.sqlite`;
    const backupFilePath = path.join(backupConfig.backupPath, backupFileName);

    // Ensure backup directory exists
    await ensureBackupDirectory(backupConfig.backupPath);

    // Check if source database exists
    try {
      await fs.access(sourcePath);
    } catch {
      console.warn(`Source database not found: ${sourcePath}`);
      return null;
    }

    // Copy database file
    await fs.copyFile(sourcePath, backupFilePath);
    
    // Also backup WAL and SHM files if they exist
    const walPath = `${sourcePath}-wal`;
    const shmPath = `${sourcePath}-shm`;
    
    try {
      await fs.access(walPath);
      await fs.copyFile(walPath, `${backupFilePath}-wal`);
    } catch {
      // WAL file doesn't exist, that's ok
    }
    
    try {
      await fs.access(shmPath);
      await fs.copyFile(shmPath, `${backupFilePath}-shm`);
    } catch {
      // SHM file doesn't exist, that's ok
    }

    // Clean up old backups
    await cleanupOldBackups(backupConfig.backupPath, backupConfig.maxBackups);

    console.log(`Database backup created: ${backupFilePath}`);
    return backupFilePath;
  } catch (error) {
    console.error('Failed to backup database:', error);
    throw error;
  }
};

// Restore database from backup
export const restoreSQLiteDatabase = async (backupFilePath: string): Promise<void> => {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.dialect !== 'sqlite' || !dbConfig.storage) {
    throw new Error('Restore is only supported for SQLite databases');
  }

  try {
    // Check if backup file exists
    await fs.access(backupFilePath);
    
    // Create backup of current database before restore
    const currentBackupPath = `${dbConfig.storage}.pre-restore-${getTimestamp()}`;
    try {
      await fs.copyFile(dbConfig.storage, currentBackupPath);
      console.log(`Current database backed up to: ${currentBackupPath}`);
    } catch {
      // Current database might not exist, that's ok
    }

    // Restore from backup
    await fs.copyFile(backupFilePath, dbConfig.storage);
    
    // Restore WAL and SHM files if they exist in backup
    const walBackupPath = `${backupFilePath}-wal`;
    const shmBackupPath = `${backupFilePath}-shm`;
    
    try {
      await fs.access(walBackupPath);
      await fs.copyFile(walBackupPath, `${dbConfig.storage}-wal`);
    } catch {
      // WAL backup doesn't exist, that's ok
    }
    
    try {
      await fs.access(shmBackupPath);
      await fs.copyFile(shmBackupPath, `${dbConfig.storage}-shm`);
    } catch {
      // SHM backup doesn't exist, that's ok
    }

    console.log(`Database restored from: ${backupFilePath}`);
  } catch (error) {
    console.error('Failed to restore database:', error);
    throw error;
  }
};

// List available backups with metadata
export const listBackups = async (): Promise<Array<{name: string, size: number, created: string}>> => {
  const backupConfig = getBackupConfig();
  
  try {
    const files = await fs.readdir(backupConfig.backupPath);
    const backupFiles = await Promise.all(
      files
        .filter(file => file.endsWith('.sqlite'))
        .map(async (file) => {
          try {
            const filePath = path.join(backupConfig.backupPath, file);
            const stats = await fs.stat(filePath);
            return {
              name: file,
              size: stats.size,
              created: stats.birthtime.toISOString()
            };
          } catch (error) {
            console.error(`Failed to get stats for ${file}:`, error);
            return {
              name: file,
              size: 0,
              created: new Date().toISOString()
            };
          }
        })
    );
    
    return backupFiles.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
  } catch (error) {
    console.error('Failed to list backups:', error);
    return [];
  }
};