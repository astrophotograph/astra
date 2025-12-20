'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface BackupFile {
  name: string
  size: number
  created: string
}

interface BackupStatus {
  enabled: boolean
  intervalHours: number
  maxBackups: number
  backupPath: string
  running: boolean
}

export default function AdminPage() {
  const [backupFiles, setBackupFiles] = useState<BackupFile[]>([])
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    loadBackupData()
  }, [])

  const loadBackupData = async () => {
    try {
      const [filesResponse, statusResponse] = await Promise.all([
        fetch('/api/backup?action=list'),
        fetch('/api/backup?action=status')
      ])

      if (filesResponse.ok) {
        const filesData = await filesResponse.json()
        setBackupFiles(filesData.files || [])
      }

      if (statusResponse.ok) {
        const statusData = await statusResponse.json()
        // Combine status and config into the expected format
        const combinedStatus = {
          enabled: statusData.config?.enabled || false,
          intervalHours: statusData.config?.intervalHours || 24,
          maxBackups: statusData.config?.maxBackups || 7,
          backupPath: statusData.config?.backupPath || './backups',
          running: statusData.status?.running || false
        }
        setBackupStatus(combinedStatus)
      }
    } catch {
      setMessage('Failed to load backup data')
    }
  }

  const handleBackupAction = async (action: string) => {
    setLoading(true)
    setMessage('')

    try {
      const response = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      })

      const data = await response.json()
      
      if (response.ok) {
        setMessage(data.message || `${action} completed successfully`)
        await loadBackupData()
      } else {
        setMessage(data.error || `Failed to ${action}`)
      }
    } catch {
      setMessage(`Failed to ${action}`)
    } finally {
      setLoading(false)
    }
  }

  const handleRestore = async (filename: string) => {
    if (!confirm(`Are you sure you want to restore from ${filename}? This will replace the current database.`)) {
      return
    }

    setLoading(true)
    setMessage('')

    try {
      const response = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      })

      const data = await response.json()
      
      if (response.ok) {
        setMessage('Database restored successfully')
        await loadBackupData()
      } else {
        setMessage(data.error || 'Failed to restore database')
      }
    } catch {
      setMessage('Failed to restore database')
    } finally {
      setLoading(false)
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString()
  }

  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-900 via-purple-900 to-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-4xl font-bold text-slate-100">
            Admin - Backup Management
          </h1>
          <Link href="/" className="text-slate-300 hover:text-slate-100 transition-colors">
            ← Back to Home
          </Link>
        </div>

        {message && (
          <div className={`mb-6 p-4 rounded-lg ${
            message.includes('Failed') || message.includes('error') 
              ? 'bg-red-900/50 text-red-200 border border-red-700/50' 
              : 'bg-green-900/50 text-green-200 border border-green-700/50'
          }`}>
            {message}
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-8">
          {/* Backup Status Panel */}
          <div className="bg-slate-800/80 rounded-lg border border-slate-600/70 p-6">
            <h2 className="text-2xl font-semibold mb-4 text-slate-100">Backup Status</h2>
            
            {backupStatus ? (
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-slate-300">Status:</span>
                  <span className={`font-medium ${backupStatus.enabled ? 'text-green-400' : 'text-red-400'}`}>
                    {backupStatus.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-300">Scheduler:</span>
                  <span className={`font-medium ${backupStatus.running ? 'text-green-400' : 'text-red-400'}`}>
                    {backupStatus.running ? 'Running' : 'Stopped'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-300">Interval:</span>
                  <span className="text-slate-100">{backupStatus.intervalHours} hours</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-300">Max Backups:</span>
                  <span className="text-slate-100">{backupStatus.maxBackups}</span>
                </div>
              </div>
            ) : (
              <div className="text-slate-400">Loading status...</div>
            )}

            <div className="mt-6 space-y-3">
              <button
                onClick={() => handleBackupAction('backup')}
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white py-2 px-4 rounded-lg transition-colors"
              >
                {loading ? 'Creating...' : 'Create Backup Now'}
              </button>
              
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleBackupAction('start')}
                  disabled={loading}
                  className="bg-green-600 hover:bg-green-700 disabled:bg-green-800 text-white py-2 px-4 rounded-lg transition-colors"
                >
                  Start Scheduler
                </button>
                <button
                  onClick={() => handleBackupAction('stop')}
                  disabled={loading}
                  className="bg-red-600 hover:bg-red-700 disabled:bg-red-800 text-white py-2 px-4 rounded-lg transition-colors"
                >
                  Stop Scheduler
                </button>
              </div>
            </div>
          </div>

          {/* Backup Files Panel */}
          <div className="bg-slate-800/80 rounded-lg border border-slate-600/70 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-semibold text-slate-100">Backup Files</h2>
              <button
                onClick={loadBackupData}
                className="text-slate-400 hover:text-slate-200 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>

            <div className="space-y-2 max-h-96 overflow-y-auto">
              {backupFiles.length > 0 ? (
                backupFiles.map((file) => (
                  <div key={file.name} className="bg-slate-700/50 rounded-lg p-4 border border-slate-600/50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-slate-100 font-medium break-all">{file.name}</span>
                      <button
                        onClick={() => handleRestore(file.name)}
                        disabled={loading}
                        className="ml-2 bg-orange-600 hover:bg-orange-700 disabled:bg-orange-800 text-white px-3 py-1 rounded text-sm transition-colors flex-shrink-0"
                      >
                        Restore
                      </button>
                    </div>
                    <div className="flex justify-between text-sm text-slate-400">
                      <span>{formatFileSize(file.size)}</span>
                      <span>{formatDate(file.created)}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-slate-400 text-center py-8">
                  No backup files found
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}