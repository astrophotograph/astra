// Define all model associations here to avoid circular dependencies
import {User} from './models/User'
import {AstronomyTodo} from './models/AstronomyTodo'
import {AstroObject} from './models/AstroObject'
import {Collection} from './models/Collection'
import {Image} from './models/Image'
import {ObservationSchedule} from './models/ObservationSchedule'

// Ensure all models are loaded before setting up associations
console.log('Loading models:', { User, AstronomyTodo, AstroObject, Collection, Image });


// User associations
User.hasMany(AstronomyTodo, { foreignKey: 'user_id', as: 'astronomy_todos' });
User.hasMany(Collection, { foreignKey: 'user_id', as: 'collections' });
User.hasMany(Image, { foreignKey: 'user_id', as: 'images' });
User.hasMany(ObservationSchedule, { foreignKey: 'user_id', as: 'observation_schedules' });

// AstronomyTodo associations
AstronomyTodo.belongsTo(User, { foreignKey: 'user_id', as: 'users' });

// ObservationSchedule associations
ObservationSchedule.belongsTo(User, { foreignKey: 'user_id', as: 'users' });

// Collection associations
Collection.belongsTo(User, { foreignKey: 'user_id', as: 'users' });
// Collection.hasMany(Image, { foreignKey: 'collection_id', as: 'images' });

// Image associations
// Image.belongsTo(Collection, { foreignKey: 'collection_id', as: 'collection' });
Image.belongsTo(User, { foreignKey: 'user_id', as: 'users' });

// Many-to-many relationship with Collections
Image.belongsToMany(Collection, {
  through: 'collectionimage',
  foreignKey: 'image_id',
  otherKey: 'collection_id',
  as: 'collections',
});

Collection.belongsToMany(Image, {
  through: 'collectionimage',
  foreignKey: 'collection_id',
  otherKey: 'image_id',
  as: 'images',
});

export function initializeAssociations() {
  // This function can be called after all models are loaded
  // to ensure associations are properly set up
  console.log('Database associations initialized');
}

// Export models for easier importing
export {
  User,
  AstronomyTodo,
  AstroObject,
  Collection,
  Image,
  ObservationSchedule,
};
