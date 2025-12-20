import {DataTypes, Model, Optional} from 'sequelize'
import {sequelize} from '../connection'

export interface AstronomyTodoAttributes {
  id: string;
  user_id: string;
  name: string;
  ra: string;
  dec: string;
  magnitude: string;
  size: string;
  objectType?: string;
  addedAt: string;
  completed: boolean;
  completedAt?: string;
  goalTime?: string;
  notes?: string;
  flagged: boolean;
  last_updated?: string;
  created_at: Date;
  updated_at: Date;
}

export interface AstronomyTodoCreationAttributes
  extends Optional<AstronomyTodoAttributes, 'id' | 'created_at' | 'updated_at' | 'last_updated' | 'flagged'> {}

export class AstronomyTodo extends Model<AstronomyTodoAttributes, AstronomyTodoCreationAttributes>
  implements AstronomyTodoAttributes {
  declare id: string;
  declare user_id: string;
  declare name: string;
  declare ra: string;
  declare dec: string;
  declare magnitude: string;
  declare size: string;
  declare objectType?: string;
  declare addedAt: string;
  declare completed: boolean;
  declare completedAt?: string;
  declare goalTime?: string;
  declare notes?: string;
  declare flagged: boolean;
  declare last_updated?: string;
  declare created_at: Date;
  declare updated_at: Date;
}

AstronomyTodo.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    user_id: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    ra: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    dec: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    magnitude: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    size: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    objectType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    addedAt: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    completed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    completedAt: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    goalTime: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    flagged: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    last_updated: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: 'AstronomyTodo',
    tableName: 'astronomy_todos',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        fields: ['user_id'],
      },
      {
        fields: ['completed'],
      },
      {
        fields: ['flagged'],
      },
    ],
  }
);

