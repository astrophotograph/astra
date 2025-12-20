'use client'

import {Collection, getImageUrl, Image, User} from "@/lib/models"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {Button} from "@/components/ui/button"
import {useEffect, useState} from "react"
import {addImageToCollection} from "@/app/c/[id]/add-image-to-collection"
import {uploadImage} from "@/app/c/[id]/upload-image"
import {useRouter} from "next/navigation"
import {getUserImages} from "@/app/c/[id]/get-user-images"
import {Plus} from "lucide-react"
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs"
import {Input} from "@/components/ui/input"
import {Textarea} from "@/components/ui/textarea"
import {Label} from "@/components/ui/label"

interface AddImageFormProps {
  collection: Collection
  user: User
}

export function AddImageForm({collection, user}: AddImageFormProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [images, setImages] = useState<Image[]>([])
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadForm, setUploadForm] = useState({
    summary: '',
    description: ''
  })
  const [activeTab, setActiveTab] = useState('library')

  useEffect(() => {
    if (open) {
      loadUserImages()
    }
  }, [open])

  const loadUserImages = async () => {
    try {
      const userImages = await getUserImages(user.id!)
      setImages(userImages)
    } catch (error) {
      console.error('Failed to load user images:', error)
    }
  }

  const handleAddImage = async () => {
    if (!selectedImageId) return

    setLoading(true)
    try {
      await addImageToCollection(collection.id!, selectedImageId)
      setOpen(false)
      setSelectedImageId(null)
      router.refresh()
    } catch (error) {
      console.error('Failed to add image to collection:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleFileUpload = async () => {
    if (!selectedFile) return

    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('file', selectedFile)
      formData.append('summary', uploadForm.summary || selectedFile.name)
      formData.append('description', uploadForm.description)

      const uploadedImage = await uploadImage(formData, user.id!)
      await addImageToCollection(collection.id!, uploadedImage.id)

      setOpen(false)
      setSelectedFile(null)
      setUploadForm({ summary: '', description: '' })
      router.refresh()
    } catch (error) {
      console.error('Failed to upload and add image:', error)
      alert('Failed to upload image: ' + (error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      if (!uploadForm.summary) {
        setUploadForm(prev => ({ ...prev, summary: file.name.split('.')[0] }))
      }
    }
  }


  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={'outline'} size={'sm'}>
          <Plus className="h-4 w-4 mr-2" />
          Add Image
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Add Image to Collection</DialogTitle>
          <DialogDescription>
            Upload a new image or select from your existing library.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="library">Library</TabsTrigger>
            <TabsTrigger value="upload">Upload</TabsTrigger>
          </TabsList>

          <TabsContent value="library" className="mt-4 max-h-[400px] overflow-y-auto">
            {images.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No images found in your library.
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {images.map((image) => (
                  <div
                    key={image.id}
                    className={`relative cursor-pointer border-2 rounded-lg overflow-hidden transition-all ${
                      selectedImageId === image.id
                        ? 'border-blue-500 ring-2 ring-blue-200'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setSelectedImageId(image.id!)}
                  >
                    <img
                      src={getImageUrl(image, '500')}
                      alt={image.summary || 'Image'}
                      className="w-full h-32 object-cover"
                    />
                    <div className="p-2">
                      <p className="text-sm font-medium truncate">
                        {image.summary || 'Untitled'}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {image.description || 'No description'}
                      </p>
                    </div>
                    {selectedImageId === image.id && (
                      <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-1">
                        <Plus className="h-3 w-3" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="upload" className="mt-4 space-y-4">
            <div className="space-y-4">
              <div>
                <Label htmlFor="file-upload">Select Image</Label>
                <Input
                  id="file-upload"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileChange}
                  className="mt-1"
                />
                {selectedFile && (
                  <p className="text-sm text-gray-500 mt-1">
                    Selected: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
                  </p>
                )}
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
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          {activeTab === 'library' ? (
            <Button
              onClick={handleAddImage}
              disabled={!selectedImageId || loading}
            >
              {loading ? 'Adding...' : 'Add Image'}
            </Button>
          ) : (
            <Button
              onClick={handleFileUpload}
              disabled={!selectedFile || loading}
            >
              {loading ? 'Uploading...' : 'Upload & Add'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
