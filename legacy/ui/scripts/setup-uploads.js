#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

async function setupUploads() {
  const uploadsDir = process.env.UPLOAD_DIR || './uploads';
  const publicUploadsDir = './public/uploads';
  
  try {
    // Create uploads directory if it doesn't exist
    await fs.promises.mkdir(uploadsDir, { recursive: true });
    console.log(`✓ Created uploads directory: ${uploadsDir}`);
    
    // Create public/uploads directory if it doesn't exist  
    await fs.promises.mkdir(publicUploadsDir, { recursive: true });
    console.log(`✓ Created public uploads directory: ${publicUploadsDir}`);
    
    // Add .gitkeep files to preserve empty directories
    const gitkeepPath1 = path.join(uploadsDir, '.gitkeep');
    const gitkeepPath2 = path.join(publicUploadsDir, '.gitkeep');
    
    await fs.promises.writeFile(gitkeepPath1, '');
    await fs.promises.writeFile(gitkeepPath2, '');
    
    console.log('✓ Added .gitkeep files to preserve directories');
    console.log('✓ Upload directories setup complete!');
    
  } catch (error) {
    console.error('Error setting up uploads:', error);
    process.exit(1);
  }
}

setupUploads();