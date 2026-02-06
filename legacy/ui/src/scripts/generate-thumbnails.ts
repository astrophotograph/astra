#!/usr/bin/env tsx

/**
 * Script to generate thumbnails for existing images that don't have them
 * Usage: npx tsx src/scripts/generate-thumbnails.ts
 */

import { Image } from '@/lib/database';
import { generateThumbnails } from '@/lib/image-processing';
import { readFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

async function generateThumbnailsForExistingImages() {
  console.log('Starting thumbnail generation for existing images...');
  
  try {
    // Find all images that don't have thumbnails in metadata
    const images = await Image.findAll();
    
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const image of images) {
      const metadata = image.metadata_ || {};
      
      // Skip if thumbnails and placeholder already exist
      if ((metadata.thumb500 || metadata.thumb1000) && metadata.placeholder) {
        skippedCount++;
        continue;
      }
      
      try {
        console.log(`Processing image: ${image.id} (${image.filename})`);
        
        // Read the image file
        const buffer = await readFile(image.url);
        const imageDir = dirname(image.url);
        const originalFilename = image.url.split('/').pop() || image.filename;
        
        // Generate thumbnails
        const thumbnails = await generateThumbnails(buffer, originalFilename, imageDir);
        
        if (thumbnails.thumb500 || thumbnails.thumb1000 || thumbnails.placeholder) {
          // Update metadata with thumbnail paths and placeholder
          const updatedMetadata = {
            ...metadata,
            ...(thumbnails.thumb500 && { thumb500: thumbnails.thumb500 }),
            ...(thumbnails.thumb1000 && { thumb1000: thumbnails.thumb1000 }),
            ...(thumbnails.placeholder && { placeholder: thumbnails.placeholder })
          };
          
          await image.update({ metadata_: updatedMetadata });
          
          console.log(`✓ Generated thumbnails for ${image.filename}`);
          if (thumbnails.thumb500) console.log(`  - 500px: ${thumbnails.thumb500}`);
          if (thumbnails.thumb1000) console.log(`  - 1000px: ${thumbnails.thumb1000}`);
          if (thumbnails.placeholder) console.log(`  - Placeholder: ${thumbnails.placeholder.substring(0, 50)}...`);
          
          updatedCount++;
        } else {
          console.log(`✗ Could not generate thumbnails for ${image.filename}`);
          errorCount++;
        }
      } catch (error) {
        console.error(`✗ Error processing ${image.filename}:`, error);
        errorCount++;
      }
    }
    
    console.log('\n=== Thumbnail Generation Summary ===');
    console.log(`Total images: ${images.length}`);
    console.log(`Generated thumbnails: ${updatedCount}`);
    console.log(`Skipped (already had thumbnails): ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    
  } catch (error) {
    console.error('Failed to generate thumbnails:', error);
    process.exit(1);
  }
}

// Run the script
generateThumbnailsForExistingImages()
  .then(() => {
    console.log('Thumbnail generation completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });