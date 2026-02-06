'use client'

import {Card, CardContent} from "@/components/ui/card"
import type {Collection, User} from "@/lib/models"
import {cx} from "class-variance-authority"
import {useState, useRef, useTransition} from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {Textarea} from "@/components/ui/textarea"
import {Label} from "@/components/ui/label"
import {uploadImage} from "@/app/c/[id]/upload-image"
import {addImageToCollection} from "@/app/c/[id]/add-image-to-collection"
import {useRouter} from "next/navigation"
import Link from "next/link"

interface ObservationLogCardClientProps {
  collection: Collection
  user: User | null
  imageCount: number
  size?: 'small' | 'medium'
  isEditable?: boolean
}

export function ObservationLogCardClient({
  collection,
  user,
  imageCount,
  size = 'small',
  isEditable = false
}: ObservationLogCardClientProps) {
  const router = useRouter()
  const [isDragOver, setIsDragOver] = useState(false)
  const [showUploadDialog, setShowUploadDialog] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isPending, startTransition] = useTransition()
  const [uploadForm, setUploadForm] = useState({
    summary: '',
    description: ''
  })
  const fileInputRef = useRef<HTMLInputElement>(null)

  const containerHeight = size == 'small' ? 'h-80' : 'h-96'
  const tags = collection && collection.tags ? collection.tags.split(',') : []

  const handleDragOver = (e: React.DragEvent) => {
    if (!isEditable) return
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    
    if (!isEditable) return

    const files = Array.from(e.dataTransfer.files)
    const imageFile = files.find(file => file.type.startsWith('image/'))
    
    if (imageFile) {
      setSelectedFile(imageFile)
      setUploadForm(prev => ({ 
        ...prev, 
        summary: imageFile.name.split('.')[0] 
      }))
      setShowUploadDialog(true)
    }
  }

  const handleFileUpload = () => {
    if (!selectedFile || !user) return

    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.append('file', selectedFile)
        formData.append('summary', uploadForm.summary || selectedFile.name)
        formData.append('description', uploadForm.description)

        // Call server actions properly
        const uploadedImage = await uploadImage(formData, user.id!)
        await addImageToCollection(collection.id!, uploadedImage.id)

        setShowUploadDialog(false)
        setSelectedFile(null)
        setUploadForm({ summary: '', description: '' })
        router.refresh()
      } catch (error) {
        console.error('Failed to upload and add image:', error)
        alert('Failed to upload image: ' + (error as Error).message)
      }
    })
  }

  const cardContent = (
    <Card className={cx(
      'pt-0 relative overflow-hidden transition-all duration-200',
      containerHeight,
      isDragOver && isEditable ? 'ring-2 ring-blue-500 ring-opacity-50 bg-blue-50' : ''
    )}>
      <CardContent className={'p-0 relative overflow-hidden'}>
        <img 
          src={collection.favorite_image!}
          alt={collection.name}
          className={"object-cover w-full h-96 relative"}
        />
        
        {/* Drag overlay */}
        {isDragOver && isEditable && (
          <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center">
            <div className="bg-white/90 p-4 rounded-lg text-center">
              <p className="text-lg font-semibold text-blue-600">Drop image to add to collection</p>
            </div>
          </div>
        )}
        
        {/* Collection title overlay at top */}
        <div className={'absolute top-0 left-0 right-0 bg-gradient-to-b from-black/60 to-transparent p-3'}>
          <h3 className={'text-white font-semibold text-lg leading-tight'}>{collection.name}</h3>
        </div>
        
        {/* Photo count and tags at bottom */}
        <div className={'absolute bottom-1 left-1 text-sm text-white bg-black/50 px-2 py-1 rounded'}>{imageCount} photos</div>
        <div className={'absolute bottom-1 right-1 space-x-2'}>
          {tags.map((tag) => (
            <span key={tag} className={'bg-amber-800 px-2 py-0.5 text-xs rounded-lg'}>{tag}</span>
          ))}
        </div>
      </CardContent>
      
      {/* Session date at bottom */}
      {collection.session_date && (
        <div className={'absolute bottom-0 left-0 right-0 bg-black/60 text-center py-1'}>
          <p className={'text-white text-sm'}>{collection.session_date}</p>
        </div>
      )}
    </Card>
  )

  return (
    <>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="relative"
      >
        <Link href={`/c/${collection.id}`}>
          {cardContent}
        </Link>
      </div>

      {/* Upload Dialog */}
      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Add Image to {collection.name}</DialogTitle>
            <DialogDescription>
              Upload and add the selected image to this collection.
            </DialogDescription>
          </DialogHeader>

          {selectedFile && (
            <div className="space-y-4">
              <div className="text-sm text-gray-500">
                Selected: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
              </div>

              <div>
                <Label htmlFor="summary">Title</Label>
                <Input
                  id="summary"
                  value={uploadForm.summary}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, summary: e.target.value }))}
                  placeholder="Image title"
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={uploadForm.description}
                  onChange={(e) => setUploadForm(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Image description (optional)"
                  className="mt-1"
                  rows={3}
                />
              </div>

              <div className="flex justify-end space-x-2">
                <Button
                  variant="secondary"
                  onClick={() => setShowUploadDialog(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleFileUpload}
                  disabled={isPending}
                >
                  {isPending ? 'Uploading...' : 'Upload & Add'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}