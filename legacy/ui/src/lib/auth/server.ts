import {getDatabaseConfig} from '@/lib/database/config'

/**
 * Server-side function to check if we're in SQLite mode
 * This can be used in server components and API routes
 */
export const isSQLiteModeServer = (): boolean => {
  try {
    const config = getDatabaseConfig();
    return config.dialect === 'sqlite';
  } catch (error) {
    console.error('Error checking SQLite mode:', error);
    return false;
  }
};

/**
 * Server-side function to check if SQLite auto-login should be used
 * This is the server equivalent of shouldUseSQLiteAutoLogin
 */
export const shouldUseSQLiteAutoLoginServer = (): boolean => {
  return isSQLiteModeServer();
};
