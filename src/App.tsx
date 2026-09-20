import { useEffect, useState } from 'react'
import { Room, RoomEvent, Track } from 'livekit-client'

import './App.css'

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL

function App() {
  const [status, setStatus] = useState('Start a conversation')
  const [room, setRoom] = useState<Room | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [speakerConversationId, setSpeakerConversationId] =
    useState<string | null>(null)
  const [speakerName, setSpeakerName] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const joinId = params.get('join')

    if (joinId) {
      setSpeakerConversationId(joinId)
      setStatus('Ready to join conversation')
    }
  }, [])

  async function getToken(roomName: string, identity: string) {
    const response = await fetch(
      `http://localhost:3001/token?room=${encodeURIComponent(
        roomName
      )}&identity=${encodeURIComponent(identity)}`
    )

    if (!response.ok) {
      throw new Error('Token request failed')
    }

    const data = await response.json()
    return data.token
  }

  function createConversationId() {
    return crypto.randomUUID()
  }

  function getSpeakerLink(id: string) {
    return `${window.location.origin}?join=${encodeURIComponent(id)}`
  }

  async function startConversation() {
    try {
      setStatus('Starting conversation...')

      const newConversationId = createConversationId()

      const token = await getToken(
        newConversationId,
        `listener-${Date.now()}`
      )

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

      setConversationId(newConversationId)
      setRoom(newRoom)

      setStatus('Conversation live — waiting for speaker ✓')
    } catch (error) {
      console.error(error)
      setStatus('Could not start conversation')
    }
  }

  async function joinAsSpeaker() {
    if (!speakerConversationId) {
      return
    }

    const name = speakerName.trim()

    if (!name) {
      setStatus('Enter your name before joining')
      return
    }

    try {
      setStatus('Connecting speaker...')

      const token = await getToken(
        speakerConversationId,
        `speaker-${name}-${Date.now()}`
      )

      const newRoom = new Room()

      await newRoom.connect(LIVEKIT_URL, token)

      /*
       * Audio Baseline 1:
       * Keep the known-good microphone path unchanged.
       */
      await newRoom.localParticipant.setMicrophoneEnabled(true)

      setRoom(newRoom)

      setStatus(`${name} — microphone live ✓`)
    } catch (error) {
      console.error(error)
      setStatus('Could not join conversation')
    }
  }

  async function copySpeakerLink() {
    if (!conversationId) {
      return
    }

    const speakerLink = getSpeakerLink(conversationId)

    try {
      await navigator.clipboard.writeText(speakerLink)

      setCopied(true)

      window.setTimeout(() => {
        setCopied(false)
      }, 2000)
    } catch (error) {
      console.error(error)
      setStatus('Could not copy speaker link')
    }
  }

  async function leave() {
    await room?.disconnect()

    document
      .querySelectorAll('audio')
      .forEach((element) => element.remove())

    setRoom(null)
    setConversationId(null)

    if (speakerConversationId) {
      setStatus('Ready to join conversation')
    } else {
      setStatus('Start a conversation')
    }
  }

  const isSpeakerInvite = Boolean(speakerConversationId)

  return (
    <main>
      <h1>WEGN Hear</h1>

      <p>HD Audio</p>

      {isSpeakerInvite ? (
        !room ? (
          <>
            <h2>You've been invited to speak</h2>

            <p>Enter your name, then join the conversation.</p>

            <input
              type="text"
              value={speakerName}
              onChange={(event) => setSpeakerName(event.target.value)}
              placeholder="Your name"
              autoComplete="name"
            />

            <button
              type="button"
              onClick={joinAsSpeaker}
              disabled={!speakerName.trim()}
            >
              Join Conversation
            </button>

            <p>{status}</p>
          </>
        ) : (
          <>
            <p>{status}</p>

            <button type="button" onClick={leave}>
              Leave Conversation
            </button>
          </>
        )
      ) : !room ? (
        <>
          <button type="button" onClick={startConversation}>
            Start Conversation
          </button>

          <p>{status}</p>
        </>
      ) : (
        <>
          <p>{status}</p>

          <h2>Invite a speaker</h2>

          <p>Send this link to anyone you want to hear.</p>

          <button type="button" onClick={copySpeakerLink}>
            {copied ? 'Link Copied ✓' : 'Copy Speaker Link'}
          </button>

          <button type="button" onClick={leave}>
            End Conversation
          </button>
        </>
      )}
    </main>
  )
}

export default App