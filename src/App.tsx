import { useState } from 'react'
import { Room, RoomEvent, Track } from 'livekit-client'

import './App.css'

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL

function App() {
  const [status, setStatus] = useState('Choose a role')
  const [room, setRoom] = useState<Room | null>(null)

  async function getToken(identity: string) {
    const response = await fetch(
      `http://localhost:3001/token?room=wegn-hear-test&identity=${identity}`
    )

    if (!response.ok) {
      throw new Error('Token request failed')
    }

    const data = await response.json()
    return data.token
  }

  async function joinSpeaker() {
    try {
      setStatus('Connecting speaker...')

      const token = await getToken(`speaker-${Date.now()}`)

      const newRoom = new Room()

      await newRoom.connect(LIVEKIT_URL, token)

      await newRoom.localParticipant.setMicrophoneEnabled(true)

      setRoom(newRoom)

      setStatus('Speaker connected — microphone live ✓')
    } catch (error) {
      console.error(error)
      setStatus('Speaker connection failed')
    }
  }

  async function joinListener() {
    try {
      setStatus('Connecting listener...')

      const token = await getToken(`listener-${Date.now()}`)

      const newRoom = new Room()

      newRoom.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach()
          element.autoplay = true
          document.body.appendChild(element)
        }
      })

      await newRoom.connect(LIVEKIT_URL, token)

      await newRoom.startAudio()

      setRoom(newRoom)

      setStatus('Listener connected — waiting for speaker ✓')
    } catch (error) {
      console.error(error)
      setStatus('Listener connection failed')
    }
  }

  async function leave() {
    await room?.disconnect()

    setRoom(null)
    setStatus('Disconnected')
  }

  return (
    <main>
      <h1>WEGN Hear</h1>

      <p>HD Audio Prototype</p>

      {!room ? (
        <>
          <button type="button" onClick={joinSpeaker}>
            Join as Speaker
          </button>

          <button type="button" onClick={joinListener}>
            Join as Listener
          </button>
        </>
      ) : (
        <button type="button" onClick={leave}>
          Leave
        </button>
      )}

      <p>{status}</p>
    </main>
  )
}

export default App