#!/usr/bin/env tsx

/**
 * Script to generate placeholder data URLs for existing images that don't have them
 * Usage: npx tsx src/scripts/generate-placeholders.ts
 */

import { Image } from '@/lib/database';
import { readFile } from 'fs/promises';

async function generatePlaceholder(buffer: Buffer): Promise<string | null> {
  try {
    // Try to use sharp if available (NextJS compatible import)
    let sharp;
    try {
      sharp = (await import('sharp')).default;
    } catch (sharpError) {
      console.warn('Sharp not available, skipping placeholder generation:', sharpError);
      return null;
    }

    const image = sharp(buffer);
    
    // Generate blur placeholder data URL (small 10px image)
    const placeholderBuffer = await image
      .resize(10, 10, {
        fit: 'inside',
        withoutEnlargement: false
      })
      .blur(1)
      .jpeg({ quality: 20 })
      .toBuffer();
    
    return `data:image/jpeg;base64,${placeholderBuffer.toString('base64')}`;
  } catch (error) {
    console.warn('Could not generate placeholder:', error);
    return null;
  }
}

async function generatePlaceholdersForExistingImages() {
  console.log('Starting placeholder generation for existing images...');
  
  try {
    // Find all images that don't have placeholders in metadata
    const images = await Image.findAll();
    
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const image of images) {
      const metadata = image.metadata_ || {};
      
      // Skip if placeholder already exists
      if (metadata.placeholder) {
        skippedCount++;
        continue;
      }
      
      try {
        console.log(`Processing image: ${image.id} (${image.filename})`);
        
        // Read the image file
        const buffer = await readFile(image.url);
        
        // Generate placeholder
        const placeholder = await generatePlaceholder(buffer);
        
        if (placeholder) {
          // Update metadata with placeholder
          const updatedMetadata = {
            ...metadata,
            placeholder: placeholder
          };
          
          await image.update({ metadata_: updatedMetadata });
          
          console.log(`✓ Generated placeholder for ${image.filename}`);
          console.log(`  - Placeholder: ${placeholder.substring(0, 50)}...`);
          
          updatedCount++;
        } else {
          console.log(`✗ Could not generate placeholder for ${image.filename}`);
          errorCount++;
        }
      } catch (error) {
        console.error(`✗ Error processing ${image.filename}:`, error);
        errorCount++;
      }
    }
    
    console.log('\n=== Placeholder Generation Summary ===');
    console.log(`Total images: ${images.length}`);
    console.log(`Generated placeholders: ${updatedCount}`);
    console.log(`Skipped (already had placeholders): ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    
  } catch (error) {
    console.error('Failed to generate placeholders:', error);
    process.exit(1);
  }
}

// Run the script
generatePlaceholdersForExistingImages()
  .then(() => {
    console.log('Placeholder generation completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });