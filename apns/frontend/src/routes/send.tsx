import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useAuthStore } from '../stores/authStore'
import { notificationsApi, adminApi } from '../services/api'
import { useState } from 'react'

export const Route = createFileRoute('/send')({
  component: SendNotification,
})

type SendMode = 'device' | 'topic' | 'broadcast'

function SendNotification() {
  const { isAuthenticated } = useAuthStore()
  const [mode, setMode] = useState<SendMode>('device')
  const [deviceId, setDeviceId] = useState('')
  const [topic, setTopic] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [badge, setBadge] = useState('')
  const [sound, setSound] = useState('default')
  const [priority, setPriority] = useState<number>(10)
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  if (!isAuthenticated) {
    return <Navigate to="/login" />
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setResult(null)

    const payload = {
      aps: {
        alert: title || body ? { title, body } : undefined,
        badge: badge ? parseInt(badge, 10) : undefined,
        sound: sound || undefined,
      },
    }

    try {
      let response
      switch (mode) {
        case 'device':
          response = await notificationsApi.sendToDeviceById(deviceId, payload, { priority })
          setResult({
            success: true,
            message: `Notification sent! ID: ${response.notification_id}, Status: ${response.status}`,
          })
          break
        case 'topic':
          response = await notificationsApi.sendToTopic(topic, payload, { priority })
          setResult({
            success: true,
            message: `Topic notification sent! ID: ${response.notification_id}, Queued: ${response.queued_count || 0}`,
          })
          break
        case 'broadcast':
          response = await adminApi.broadcast(payload, priority)
          setResult({
            success: true,
            message: `Broadcast sent! Devices: ${response.total_devices}, Sent: ${response.sent}, Failed: ${response.failed}`,
          })
          break
      }
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to send notification',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Send Notification</h1>

      <div className="card max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Mode Selection */}
          <div>
            <label className="label">Send To</label>
            <div className="flex space-x-4">
              <label className="flex items-center">
                <input
                  type="radio"
                  name="mode"
                  value="device"
                  checked={mode === 'device'}
                  onChange={() => setMode('device')}
                  className="mr-2"
                />
                Device
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  name="mode"
                  value="topic"
                  checked={mode === 'topic'}
                  onChange={() => setMode('topic')}
                  className="mr-2"
                />
                Topic
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  name="mode"
                  value="broadcast"
                  checked={mode === 'broadcast'}
                  onChange={() => setMode('broadcast')}
                  className="mr-2"
                />
                Broadcast (All Devices)
              </label>
            </div>
          </div>

          {/* Device ID */}
          {mode === 'device' && (
            <div>
              <label htmlFor="deviceId" className="label">
                Device ID
              </label>
              <input
                id="deviceId"
                type="text"
                className="input"
                placeholder="Device UUID"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                required
              />
            </div>
          )}

          {/* Topic */}
          {mode === 'topic' && (
            <div>
              <label htmlFor="topic" className="label">
                Topic
              </label>
              <input
                id="topic"
                type="text"
                className="input"
                placeholder="news.sports"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                required
              />
            </div>
          )}

          {/* Notification Content */}
          <div className="border-t pt-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Notification Content</h3>

            <div className="space-y-4">
              <div>
                <label htmlFor="title" className="label">
                  Title
                </label>
                <input
                  id="title"
                  type="text"
                  className="input"
                  placeholder="Notification title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="body" className="label">
                  Body
                </label>
                <textarea
                  id="body"
                  className="input"
                  rows={3}
                  placeholder="Notification body text"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="badge" className="label">
                    Badge Number
                  </label>
                  <input
                    id="badge"
                    type="number"
                    className="input"
                    placeholder="Optional"
                    value={badge}
                    onChange={(e) => setBadge(e.target.value)}
                    min="0"
                  />
                </div>

                <div>
                  <label htmlFor="sound" className="label">
                    Sound
                  </label>
                  <input
                    id="sound"
                    type="text"
                    className="input"
                    placeholder="default"
                    value={sound}
                    onChange={(e) => setSound(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="priority" className="label">
                  Priority
                </label>
                <select
                  id="priority"
                  className="input"
                  value={priority}
                  onChange={(e) => setPriority(parseInt(e.target.value, 10))}
                >
                  <option value={10}>High (10) - Immediate delivery</option>
                  <option value={5}>Medium (5) - Power-efficient</option>
                  <option value={1}>Low (1) - Background</option>
                </select>
              </div>
            </div>
          </div>

          {/* Result Message */}
          {result && (
            <div
              className={`p-4 rounded-lg ${
                result.success
                  ? 'bg-green-50 border border-green-200 text-green-700'
                  : 'bg-red-50 border border-red-200 text-red-700'
              }`}
            >
              {result.message}
            </div>
          )}

          {/* Submit Button */}
          <div className="flex justify-end space-x-4">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setTitle('')
                setBody('')
                setBadge('')
                setSound('default')
                setDeviceId('')
                setTopic('')
                setResult(null)
              }}
            >
              Clear
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isLoading}
            >
              {isLoading ? 'Sending...' : 'Send Notification'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
