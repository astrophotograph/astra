import {Sequelize} from 'sequelize'
import {createSequelizeOptions, getDatabaseConfig} from './config'

// Initialize Sequelize
const config = getDatabaseConfig();
const options = createSequelizeOptions(config);
// console.log('Database options:', options);

export const sequelize = new Sequelize(options);

// Helper for transactions
export const withTransaction = async <T>(callback: (transaction: any) => Promise<T>): Promise<T> => {
  return await sequelize.transaction(callback);
};

// Helper to get sequelize instance
export const getSequelize = (): Sequelize => sequelize;

// Re-export Sequelize types for convenience
export { Op, Transaction, QueryTypes } from 'sequelize';
