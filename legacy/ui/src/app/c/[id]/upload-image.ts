'use server'

import {Image} from '@/lib/database'
import {fetchUser} from "@/lib/db"
import {isOwner} from "@/lib/aaa"
import {getImageDimensions, generateThumbnails} from "@/lib/image-processing"
import {mkdir, writeFile} from 'fs/promises'
import {join} from 'path'
import crypto from 'crypto'

export async function uploadImage(formData: FormData, userId: string) {
  const user = await fetchUser(userId)
  if (!await isOwner(user!)) {
    throw new Error('Not authorized to upload images')
  }

  const file = formData.get('file') as File
  if (!file) {
    throw new Error('No file provided')
  }

  // Validate file type
  const allowedTypes = (process.env.ALLOWED_FILE_TYPES || 'image/jpeg,image/png,image/webp').split(',')
  if (!allowedTypes.includes(file.type)) {
    throw new Error(`File type ${file.type} not allowed. Allowed types: ${allowedTypes.join(', ')}`)
  }

  // Validate file size (default 10MB)
  const maxSize = parseInt(process.env.MAX_FILE_SIZE || '10485760', 10)
  if (file.size > maxSize) {
    throw new Error(`File size ${file.size} exceeds maximum allowed size of ${maxSize} bytes`)
  }

  // Generate unique filename and ID
  const bytes = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)

  // Generate SHA256 hash for ID
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  const imageId = hash // Use the entire SHA256 hash as ID

  // Get file extension
  const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const filename = `${imageId}.${extension}`

  // Create upload directory if it doesn't exist
  const uploadDir = process.env.UPLOAD_DIR || './uploads'
  const userDir = join(uploadDir, userId)
  await mkdir(userDir, { recursive: true })

  // Save file
  const filepath = join(userDir, filename)
  await writeFile(filepath, buffer)

  // Create public symlink path for web serving (relative to public directory)
  const publicUploadsDir = './public/uploads'
  const publicUserDir = join(publicUploadsDir, userId)

  try {
    await mkdir(publicUserDir, { recursive: true })
    // Create symlink from public/uploads to actual uploads directory
    const { symlink, access } = await import('fs/promises')
    
    // Create symlink for main image
    const symlinkPath = join(publicUserDir, filename)
    const targetPath = join('../../../', filepath)

    try {
      await access(symlinkPath)
    } catch {
      // Symlink doesn't exist, create it
      await symlink(targetPath, symlinkPath)
    }
  } catch (error) {
    console.warn('Could not create public symlink, falling back to API serving:', error)
  }

  // Get image dimensions
  const dimensions = await getImageDimensions(buffer)
  
  // Generate thumbnails
  const thumbnails = await generateThumbnails(buffer, filename, userDir)
  
  // Create symlinks for thumbnails
  try {
    const { symlink, access } = await import('fs/promises')
    
    if (thumbnails.thumb500) {
      const thumbSymlinkPath = join(publicUserDir, `${imageId}_thumb500.${extension}`)
      const thumbTargetPath = join('../../../', thumbnails.thumb500)
      try {
        await access(thumbSymlinkPath)
      } catch {
        await symlink(thumbTargetPath, thumbSymlinkPath)
      }
    }
    
    if (thumbnails.thumb1000) {
      const thumbSymlinkPath = join(publicUserDir, `${imageId}_thumb1000.${extension}`)
      const thumbTargetPath = join('../../../', thumbnails.thumb1000)
      try {
        await access(thumbSymlinkPath)
      } catch {
        await symlink(thumbTargetPath, thumbSymlinkPath)
      }
    }
  } catch (error) {
    console.warn('Could not create thumbnail symlinks:', error)
  }
  
  // Get image metadata
  const metadata = {
    originalName: file.name,
    size: file.size,
    type: file.type,
    uploadedAt: new Date().toISOString(),
    ...(dimensions && { width: dimensions.width, height: dimensions.height }),
    ...(thumbnails.thumb500 && { thumb500: thumbnails.thumb500 }),
    ...(thumbnails.thumb1000 && { thumb1000: thumbnails.thumb1000 }),
    ...(thumbnails.placeholder && { placeholder: thumbnails.placeholder })
  }

  // Save to database using Sequelize ORM
  const newImage = await Image.create({
    id: imageId,
    user_id: userId,
    filename: file.name,
    url: filepath,
    metadata_: metadata,
    summary: formData.get('summary') as string || file.name,
    description: formData.get('description') as string || '',
    content_type: file.type,
    favorite: false,
    visibility: 'private',
  })
  console.log('new image:', newImage)

  return {
    id: imageId,
    filename: file.name,
    url: filepath,
    metadata: metadata,
  }
}
