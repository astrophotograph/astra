/**
 * Image processing utilities for dimension extraction and thumbnail generation
 */

export async function getImageDimensions(buffer: Buffer): Promise<{width: number, height: number} | null> {
  try {
    // Try to use sharp if available (NextJS compatible import)
    try {
      const sharp = (await import('sharp')).default;
      const metadata = await sharp(buffer).metadata();
      if (metadata.width && metadata.height) {
        return { width: metadata.width, height: metadata.height };
      }
    } catch (sharpError) {
      console.warn('Sharp not available or failed, using fallback parser:', sharpError);
    }

    // Fallback: basic image header parsing for common formats
    return getImageDimensionsFromBuffer(buffer);
  } catch (error) {
    console.warn('Could not extract image dimensions:', error);
    return null;
  }
}

function getImageDimensionsFromBuffer(buffer: Buffer): {width: number, height: number} | null {
  // PNG format
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  }

  // JPEG format
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] === 0xFF) {
        const marker = buffer[offset + 1];
        if (marker >= 0xC0 && marker <= 0xC3) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      } else {
        offset++;
      }
    }
  }

  // WebP format
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.toString('ascii', 12, 16) === 'VP8 ') {
      const width = buffer.readUInt16LE(26) & 0x3FFF;
      const height = buffer.readUInt16LE(28) & 0x3FFF;
      return { width, height };
    }
  }

  return null;
}

export async function generateThumbnails(
  buffer: Buffer,
  filename: string,
  outputDir: string
): Promise<{thumb500?: string, thumb1000?: string, placeholder?: string}> {
  const thumbnails: {thumb500?: string, thumb1000?: string, placeholder?: string} = {};

  try {
    // Try to use sharp if available (NextJS compatible import)
    let sharp;
    try {
      sharp = (await import('sharp')).default;
    } catch (sharpError) {
      console.warn('Sharp not available, skipping thumbnail generation:', sharpError);
      return thumbnails;
    }

    const image = sharp(buffer);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      console.warn('Could not get image dimensions for thumbnail generation');
      return thumbnails;
    }

    const baseFilename = filename.replace(/\.[^/.]+$/, ''); // Remove extension
    const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';

    // Generate 500px thumbnail
    if (metadata.width > 500 || metadata.height > 500) {
      const thumb500Path = `${outputDir}/${baseFilename}_thumb500.${ext}`;
      await image
        .clone()
        .resize(500, 500, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .toFile(thumb500Path);
      thumbnails.thumb500 = thumb500Path;
    }

    // Generate 1000px thumbnail
    if (metadata.width > 1000 || metadata.height > 1000) {
      const thumb1000Path = `${outputDir}/${baseFilename}_thumb1000.${ext}`;
      await image
        .clone()
        .resize(1000, 1000, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .toFile(thumb1000Path);
      thumbnails.thumb1000 = thumb1000Path;
    }

    // Generate blur placeholder data URL (small 10px image)
    try {
      const placeholderBuffer = await image
        .clone()
        .resize(10, 10, {
          fit: 'inside',
          withoutEnlargement: false
        })
        .blur(1)
        .jpeg({ quality: 20 })
        .toBuffer();
      
      const placeholderDataUrl = `data:image/jpeg;base64,${placeholderBuffer.toString('base64')}`;
      thumbnails.placeholder = placeholderDataUrl;
    } catch (placeholderError) {
      console.warn('Could not generate placeholder data URL:', placeholderError);
    }

    return thumbnails;
  } catch (error) {
    console.warn('Could not generate thumbnails:', error);
    return thumbnails;
  }
}