#!/usr/bin/env tsx

/**
 * Script to update existing image records with missing width/height dimensions
 * Usage: npx tsx src/scripts/update-image-dimensions.ts
 */

import { Image } from '@/lib/database';
import { getImageDimensions } from '@/lib/image-processing';
import { readFile } from 'fs/promises';

async function updateImageDimensions() {
  console.log('Starting image dimensions update...');
  
  try {
    // Find all images that don't have dimensions in metadata
    const images = await Image.findAll();
    
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const image of images) {
      const metadata = image.metadata_ || {};
      
      // Skip if dimensions already exist
      if (metadata.width && metadata.height) {
        skippedCount++;
        continue;
      }
      
      try {
        console.log(`Processing image: ${image.id} (${image.filename})`);
        
        // Read the image file
        const buffer = await readFile(image.url);
        const dimensions = await getImageDimensions(buffer);
        
        if (dimensions) {
          // Update metadata with dimensions
          const updatedMetadata = {
            ...metadata,
            width: dimensions.width,
            height: dimensions.height
          };
          
          await image.update({ metadata_: updatedMetadata });
          
          console.log(`✓ Updated ${image.filename}: ${dimensions.width}x${dimensions.height}`);
          updatedCount++;
        } else {
          console.log(`✗ Could not extract dimensions for ${image.filename}`);
          errorCount++;
        }
      } catch (error) {
        console.error(`✗ Error processing ${image.filename}:`, error);
        errorCount++;
      }
    }
    
    console.log('\n=== Update Summary ===');
    console.log(`Total images: ${images.length}`);
    console.log(`Updated: ${updatedCount}`);
    console.log(`Skipped (already had dimensions): ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    
  } catch (error) {
    console.error('Failed to update image dimensions:', error);
    process.exit(1);
  }
}

// Run the script
updateImageDimensions()
  .then(() => {
    console.log('Image dimensions update completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });