import {sequelize} from './index'

/**
 * Initialize and sync database
 * This should be called when the application starts
 */
export async function syncDatabase(force = false): Promise<void> {
  try {
    console.log('Syncing database...');

    // Test the connection
    await sequelize.authenticate();
    console.log('Database connection established successfully.');

    // Sync all models
    await sequelize.sync({ force, alter: !force });
    console.log('Database synchronized successfully.');

  } catch (error) {
    console.error('Failed to sync database:', error);
    throw error;
  }
}

/**
 * Drop all tables and recreate them
 * WARNING: This will delete all data!
 */
export async function resetDatabase(): Promise<void> {
  console.warn('Resetting database - ALL DATA WILL BE LOST!');
  await syncDatabase(true);
}

/**
 * Check if database connection is healthy
 */
export async function healthCheck(): Promise<boolean> {
  try {
    await sequelize.authenticate();
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
}
