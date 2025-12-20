'use client'

import {useState, useEffect} from 'react'
import {Input} from '@/components/ui/input'
import {Button} from '@/components/ui/button'
import {Badge} from '@/components/ui/badge'
import {X} from 'lucide-react'
import {fetchRecentTags} from '@/app/c/[id]/fetch-recent-tags'

interface TagSelectorProps {
  userId: string
  value: string
  onChange: (value: string) => void
}

export function TagSelector({userId, value, onChange}: TagSelectorProps) {
  const [recentTags, setRecentTags] = useState<string[]>([])
  const [inputValue, setInputValue] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])

  useEffect(() => {
    // Parse existing tags from value
    const tags = value ? value.split(',').map(tag => tag.trim()).filter(tag => tag) : []
    setSelectedTags(tags)
  }, [value])

  useEffect(() => {
    // Fetch recent tags
    const fetchTags = async () => {
      try {
        const tags = await fetchRecentTags(userId)
        setRecentTags(tags)
      } catch (error) {
        console.warn('Could not fetch recent tags:', error)
      }
    }
    fetchTags()
  }, [userId])

  const addTag = (tag: string) => {
    const trimmedTag = tag.trim()
    if (!trimmedTag || selectedTags.includes(trimmedTag)) return

    const newTags = [...selectedTags, trimmedTag]
    setSelectedTags(newTags)
    onChange(newTags.join(', '))
    setInputValue('')
  }

  const removeTag = (tagToRemove: string) => {
    const newTags = selectedTags.filter(tag => tag !== tagToRemove)
    setSelectedTags(newTags)
    onChange(newTags.join(', '))
  }

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(inputValue)
    }
  }

  const availableRecentTags = recentTags.filter(tag => !selectedTags.includes(tag))

  return (
    <div className="space-y-3">
      {/* Selected tags */}
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedTags.map(tag => (
            <Badge key={tag} variant="secondary" className="flex items-center gap-1">
              {tag}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-4 w-4 p-0 hover:bg-destructive hover:text-destructive-foreground"
                onClick={() => removeTag(tag)}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}

      {/* Input for new tags */}
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder="Type a tag and press Enter or comma"
      />

      {/* Recent tags */}
      {availableRecentTags.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Recent tags:</p>
          <div className="flex flex-wrap gap-2">
            {availableRecentTags.slice(0, 10).map(tag => (
              <Button
                key={tag}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addTag(tag)}
                className="h-7 text-xs"
              >
                {tag}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}