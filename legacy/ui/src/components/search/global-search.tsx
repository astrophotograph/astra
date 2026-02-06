'use client'

import {useEffect, useRef, useState} from 'react'
import {Calendar, CheckSquare, Search, Target, Telescope} from 'lucide-react'
import {Dialog, DialogContent} from '@/components/ui/dialog'
import {Input} from '@/components/ui/input'
import {cn} from '@/lib/utils'

// Dummy data for search results
const dummyData = {
  todos: [
    {
      id: '1',
      name: 'M31 - Andromeda Galaxy',
      type: 'Galaxy',
      ra: '00h 42m 44s',
      dec: '+41° 16\'',
      magnitude: '3.4',
      thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/98/Andromeda_Galaxy_%28with_h-alpha%29.jpg/320px-Andromeda_Galaxy_%28with_h-alpha%29.jpg',
      source: 'todo'
    },
    {
      id: '2',
      name: 'M42 - Orion Nebula',
      type: 'Nebula',
      ra: '05h 35m 17s',
      dec: '-05° 23\'',
      magnitude: '4.0',
      thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f3/Orion_Nebula_-_Hubble_2006_mosaic_18000.jpg/320px-Orion_Nebula_-_Hubble_2006_mosaic_18000.jpg',
      source: 'todo'
    },
    {
      id: '3',
      name: 'Saturn',
      type: 'Planet',
      ra: '22h 15m 30s',
      dec: '-12° 45\'',
      magnitude: '0.4',
      thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Saturn_during_Equinox.jpg/320px-Saturn_during_Equinox.jpg',
      source: 'todo'
    }
  ],
  schedules: [
    {
      id: '4',
      name: 'Jupiter Opposition Session',
      type: 'Observing Session',
      date: '2024-12-15',
      time: '21:00',
      thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2b/Jupiter_and_its_shrunken_Great_Red_Spot.jpg/320px-Jupiter_and_its_shrunken_Great_Red_Spot.jpg',
      source: 'schedule'
    },
    {
      id: '5',
      name: 'Geminids Meteor Shower',
      type: 'Meteor Shower',
      date: '2024-12-13',
      time: '23:00',
      thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/56/Geminids_meteor_shower_2020.jpg/320px-Geminids_meteor_shower_2020.jpg',
      source: 'schedule'
    }
  ],
  observations: [
    {
      id: '6',
      name: 'M1 - Crab Nebula',
      type: 'Supernova Remnant',
      date: '2024-11-20',
      equipment: 'SCT 8"',
      thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Crab_Nebula.jpg/320px-Crab_Nebula.jpg',
      source: 'observation'
    },
    {
      id: '7',
      name: 'Double Cluster',
      type: 'Open Cluster',
      date: '2024-11-18',
      equipment: 'Refractor 80mm',
      thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Double_Cluster.jpg/320px-Double_Cluster.jpg',
      source: 'observation'
    }
  ]
}

interface SearchResult {
  id: string
  name: string
  type: string
  thumbnail: string
  source: 'todo' | 'schedule' | 'observation'
  [key: string]: any
}

interface GlobalSearchProps {
  className?: string
}

export function GlobalSearch({ className }: GlobalSearchProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Filter results based on query
  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }

    const allData = [
      ...dummyData.todos,
      ...dummyData.schedules,
      ...dummyData.observations
    ]

    const filtered = allData.filter(item =>
      item.name.toLowerCase().includes(query.toLowerCase()) ||
      item.type.toLowerCase().includes(query.toLowerCase())
    )

    setResults(filtered)
    setSelectedIndex(0)
  }, [query])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setIsOpen(true)
      }
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Handle arrow key navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      handleResultClick(results[selectedIndex])
    }
  }

  const handleResultClick = (result: SearchResult) => {
    // Navigate based on source
    switch (result.source) {
      case 'todo':
        window.location.href = '/todo'
        break
      case 'schedule':
        window.location.href = '/plan'
        break
      case 'observation':
        window.location.href = '/observations'
        break
    }
    setIsOpen(false)
    setQuery('')
  }

  const getSourceIcon = (source: string) => {
    switch (source) {
      case 'todo':
        return <CheckSquare className="w-4 h-4 text-emerald-400" />
      case 'schedule':
        return <Calendar className="w-4 h-4 text-violet-400" />
      case 'observation':
        return <Telescope className="w-4 h-4 text-indigo-400" />
      default:
        return <Target className="w-4 h-4 text-slate-400" />
    }
  }

  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'todo':
        return 'Todo'
      case 'schedule':
        return 'Schedule'
      case 'observation':
        return 'Observation'
      default:
        return 'Unknown'
    }
  }

  // Focus input when dialog opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

  return (
    <>
      {/* Search trigger button */}
      <button
        onClick={() => setIsOpen(true)}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 text-sm text-slate-400",
          "bg-slate-800 border border-slate-600 rounded-md",
          "hover:bg-slate-700 hover:text-slate-300 transition-colors",
          "min-w-[200px] justify-between",
          className
        )}
      >
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4" />
          <span>Search...</span>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <kbd className="px-1.5 py-0.5 bg-slate-600 rounded text-slate-300">⌘</kbd>
          <kbd className="px-1.5 py-0.5 bg-slate-600 rounded text-slate-300">K</kbd>
        </div>
      </button>

      {/* Search dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="p-0 max-w-2xl bg-slate-800 border-slate-600">
          <div className="border-b border-slate-600">
            <div className="flex items-center gap-3 px-4 py-3">
              <Search className="w-5 h-5 text-slate-400" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search observations, schedules, and targets..."
                className="border-0 bg-transparent text-slate-100 placeholder-slate-400 focus-visible:ring-0 text-lg"
              />
            </div>
          </div>

          {/* Results */}
          <div className="max-h-96 overflow-y-auto">
            {results.length === 0 && query ? (
              <div className="p-8 text-center text-slate-400">
                <Target className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No results found for "{query}"</p>
              </div>
            ) : results.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <div className="space-y-4">
                  <p className="text-sm">Quick search across your astronomy data</p>
                  <div className="flex justify-center gap-6 text-xs">
                    <div className="flex items-center gap-1">
                      <CheckSquare className="w-3 h-3 text-emerald-400" />
                      <span>Todo Items</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-violet-400" />
                      <span>Schedules</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Telescope className="w-3 h-3 text-indigo-400" />
                      <span>Observations</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-2">
                {results.map((result, index) => (
                  <button
                    key={result.id}
                    onClick={() => handleResultClick(result)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 text-left",
                      "hover:bg-slate-700 transition-colors",
                      index === selectedIndex && "bg-slate-700"
                    )}
                  >
                    <img
                      src={result.thumbnail}
                      alt={result.name}
                      className="w-12 h-12 rounded-lg object-cover bg-slate-700 flex-shrink-0"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement
                        target.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMzc0MTUxIi8+CjxwYXRoIGQ9Ik0yNC4wMDAxIDEyQzI2LjIwOTIgMTIgMjggMTMuNzkwOCAyOCAxNkMyOCAxOC4yMDkyIDI2LjIwOTIgMjAgMjQuMDAwMSAyMEMyMS43OTA5IDIwIDIwIDEOLjIwOTIgMjAgMTZDMjAgMTMuNzkwOCAyMS43OTA5IDEyIDI0LjAwMDEgMTJaTTI0LjAwMDEgMjJDMzEuNzMyIDIyIDM4IDI2LjI5OCAzOCAzMlYzNEgyOFYzNEgyMFYzNEgxMFYzMkMxMCAyNi4yOTggMTYuMjY4IDIyIDI0LjAwMDEgMjJaIiBmaWxsPSIjNjM3NDhCIi8+Cjwvc3ZnPgo='
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-medium text-slate-100 truncate">{result.name}</p>
                        <span className="text-xs text-slate-400 bg-slate-600 px-2 py-0.5 rounded flex-shrink-0">
                          {result.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-slate-400">
                        <div className="flex items-center gap-1">
                          {getSourceIcon(result.source)}
                          <span>{getSourceLabel(result.source)}</span>
                        </div>
                        {result.source === 'todo' && (
                          <span>Mag {result.magnitude}</span>
                        )}
                        {result.source === 'schedule' && (
                          <span>{result.date} at {result.time}</span>
                        )}
                        {result.source === 'observation' && (
                          <span>{result.date} • {result.equipment}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div className="border-t border-slate-600 px-4 py-2 text-xs text-slate-400 flex justify-between">
              <span>Use ↑↓ to navigate</span>
              <span>Enter to select</span>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
