'use client'

import React, { useState, useCallback } from 'react'
import { uploadImage } from './upload-image'
import { addImageToCollection } from './add-image-to-collection'
import { useRouter } from 'next/navigation'

interface DragDropZoneProps {
  collectionId: string
  userId: string
  children: React.ReactNode
}

export function DragDropZone({ collectionId, userId, children }: DragDropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const router = useRouter()

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setIsUploading(true)

    try {
      const files = Array.from(e.dataTransfer.files)
      const imageFiles = files.filter(file => file.type.startsWith('image/'))

      if (imageFiles.length === 0) {
        alert('Please drop image files only')
        setIsUploading(false)
        return
      }

      for (const file of imageFiles) {
        try {
          const formData = new FormData()
          formData.append('file', file)
          formData.append('summary', file.name)
          formData.append('description', '')

          const uploadResult = await uploadImage(formData, userId)
          
          await addImageToCollection(uploadResult.id, collectionId)
        } catch (error) {
          console.error('Error uploading file:', file.name, error)
          alert(`Failed to upload ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      }

      router.refresh()
    } catch (error) {
      console.error('Error processing dropped files:', error)
      alert('Failed to process dropped files')
    } finally {
      setIsUploading(false)
    }
  }, [collectionId, userId, router])

  return (
    <div
      className={`relative ${isDragOver ? 'bg-blue-50 border-2 border-dashed border-blue-300' : ''} ${isUploading ? 'opacity-50' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-blue-50 bg-opacity-90 border-2 border-dashed border-blue-300 rounded-lg">
          <div className="text-center">
            <div className="text-blue-600 text-xl font-medium">Drop images here</div>
            <div className="text-blue-500 text-sm mt-1">Release to upload to collection</div>
          </div>
        </div>
      )}
      
      {isUploading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-white bg-opacity-75">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            <div className="text-gray-600 text-sm mt-2">Uploading images...</div>
          </div>
        </div>
      )}
      
      {children}
    </div>
  )
}