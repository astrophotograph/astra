import {sequelize} from './connection'

/**
 * Initialize SQLite database with proper settings
 * This ensures foreign keys are enabled and other SQLite-specific configurations
 */
export async function initializeSQLite(): Promise<void> {
  if (sequelize.getDialect() === 'sqlite') {
    try {
      // Enable foreign key constraints
      await sequelize.query('PRAGMA foreign_keys = ON;');

      // Set journal mode to WAL for better concurrency
      await sequelize.query('PRAGMA journal_mode = WAL;');

      // Set synchronous mode for better performance
      await sequelize.query('PRAGMA synchronous = NORMAL;');

      // Set cache size (negative value means KB)
      await sequelize.query('PRAGMA cache_size = -64000;');

      console.log('SQLite database initialized with optimized settings');
    } catch (error) {
      console.error('Failed to initialize SQLite settings:', error);
    }
  }
}

/**
 * Get SQLite database info
 */
export async function getSQLiteInfo(): Promise<any> {
  if (sequelize.getDialect() !== 'sqlite') {
    return null;
  }

  try {
    const [pragmaResults] = await Promise.all([
      sequelize.query('PRAGMA foreign_keys;'),
      sequelize.query('PRAGMA journal_mode;'),
      sequelize.query('PRAGMA synchronous;'),
      sequelize.query('PRAGMA cache_size;'),
    ]);

    return {
      foreignKeys: pragmaResults[0],
      journalMode: pragmaResults[1],
      synchronous: pragmaResults[2],
      cacheSize: pragmaResults[3],
    };
  } catch (error) {
    console.error('Failed to get SQLite info:', error);
    return null;
  }
}
