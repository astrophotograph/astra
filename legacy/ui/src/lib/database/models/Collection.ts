import {DataTypes, Model, Optional} from 'sequelize'
import {sequelize} from '../connection'

export interface CollectionAttributes {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  visibility: string;
  template?: string;
  favorite?: boolean;
  tags?: string;
  metadata_?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface CollectionCreationAttributes
  extends Optional<CollectionAttributes, 'id' | 'created_at' | 'updated_at'> {}

export class Collection extends Model<CollectionAttributes, CollectionCreationAttributes>
  implements CollectionAttributes {
  public id!: string;
  public user_id!: string;
  public name!: string;
  public description?: string;
  public visibility!: string;
  public template?: string;
  public favorite?: boolean;
  public tags?: string;
  public metadata_?: Record<string, any>;
  public created_at!: Date;
  public updated_at!: Date;
}

Collection.init(
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
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    visibility: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'public',
      validate: {
        isIn: [['public', 'private']],
      },
    },
    template: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    favorite: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    tags: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    metadata_: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        const value = this.getDataValue('metadata_');
        return value ? JSON.parse(value) : null;
      },
      set(value: any) {
        this.setDataValue('metadata_', value ? JSON.stringify(value) : null);
      },
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
    modelName: 'Collection',
    tableName: 'collections',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        fields: ['user_id'],
      },
      {
        fields: ['visibility'],
      },
      {
        fields: ['template'],
      },
    ],
  }
);
