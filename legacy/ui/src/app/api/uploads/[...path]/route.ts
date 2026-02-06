import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const uploadDir = process.env.UPLOAD_DIR || './uploads'
    const filePath = join(uploadDir, ...params.path)
    
    // Security check: ensure the path is within upload directory
    const resolvedPath = join(process.cwd(), filePath)
    const resolvedUploadDir = join(process.cwd(), uploadDir)
    
    if (!resolvedPath.startsWith(resolvedUploadDir)) {
      return new NextResponse('Access denied', { status: 403 })
    }
    
    if (!existsSync(resolvedPath)) {
      return new NextResponse('File not found', { status: 404 })
    }
    
    const file = await readFile(resolvedPath)
    
    // Determine content type based on file extension
    const ext = filePath.split('.').pop()?.toLowerCase()
    let contentType = 'application/octet-stream'
    
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        contentType = 'image/jpeg'
        break
      case 'png':
        contentType = 'image/png'
        break
      case 'webp':
        contentType = 'image/webp'
        break
      case 'gif':
        contentType = 'image/gif'
        break
    }
    
    return new NextResponse(file, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
      },
    })
  } catch (error) {
    console.error('Error serving uploaded file:', error)
    return new NextResponse('Internal server error', { status: 500 })
  }
}