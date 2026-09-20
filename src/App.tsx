import { useEffect, useState } from 'react'
import {
  Participant,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client'

import './App.css'

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL

type Speaker = {
  identity: string
  name: string
}

function App() {
  const [status, setStatus] = useState('Start a conversation')
  const [room, setRoom] = useState<Room | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [speakerConversationId, setSpeakerConversationId] =
    useState<string | null>(null)
  const [speakerName, setSpeakerName] = useState('')
  const [connectedSpeakers, setConnectedSpeakers] = useState<Speaker[]>([])
  const [focusedSpeaker, setFocusedSpeaker] = useState<string | null>(null)
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

  function getSpeakerDisplayName(participant: Participant) {
    const identity = participant.identity

    if (!identity.startsWith('speaker-')) {
      return null
    }

    const withoutPrefix = identity.slice('speaker-'.length)
    const lastDash = withoutPrefix.lastIndexOf('-')

    if (lastDash === -1) {
      return withoutPrefix
    }

    return withoutPrefix.slice(0, lastDash)
  }

  function addSpeaker(participant: Participant) {
    const name = getSpeakerDisplayName(participant)

    if (!name) {
      return
    }

    setConnectedSpeakers((current) => {
      if (current.some((speaker) => speaker.identity === participant.identity)) {
        return current
      }

      return [
        ...current,
        {
          identity: participant.identity,
          name,
        },
      ]
    })
  }

  function removeSpeaker(participant: Participant) {
    setConnectedSpeakers((current) =>
      current.filter(
        (speaker) => speaker.identity !== participant.identity
      )
    )

    setFocusedSpeaker((current) =>
      current === participant.identity ? null : current
    )
  }

  function applyFocusMode(
    currentRoom: Room,
    speakerIdentity: string | null
  ) {
    currentRoom.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((publication) => {
        const audioElement = publication.track?.attachedElements[0]

        if (!audioElement) {
          return
        }

        if (speakerIdentity === null) {
          audioElement.volume = 1
          return
        }

        audioElement.volume =
          participant.identity === speakerIdentity ? 1 : 0
      })
    })
  }

  function selectSpeaker(identity: string) {
    if (!room) {
      return
    }

    const nextFocus =
      focusedSpeaker === identity ? null : identity

    setFocusedSpeaker(nextFocus)
    applyFocusMode(room, nextFocus)
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

      newRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        addSpeaker(participant)
      })

      newRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        removeSpeaker(participant)
      })

      newRoom.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach()

          element.autoplay = true
          element.volume = 1

          document.body.appendChild(element)
        }
      })

      await newRoom.connect(LIVEKIT_URL, token)

      await newRoom.startAudio()

      newRoom.remoteParticipants.forEach((participant) => {
        addSpeaker(participant)
      })

      setConversationId(newConversationId)
      setRoom(newRoom)

      setStatus('Conversation live ✓')
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
       * Audio Baseline 1.
       * Keep this known-good microphone path unchanged.
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
    setConnectedSpeakers([])
    setFocusedSpeaker(null)

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

          <h2>Connected Speakers</h2>

          {connectedSpeakers.length === 0 ? (
            <p>Waiting for speakers...</p>
          ) : (
            <ul>
              {connectedSpeakers.map((speaker) => (
                <li key={speaker.identity}>
                  {speaker.name}{' '}

                  <button
                    type="button"
                    onClick={() => selectSpeaker(speaker.identity)}
                  >
                    {focusedSpeaker === speaker.identity
                      ? 'Focused ✓'
                      : 'Focus'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {focusedSpeaker && (
            <button
              type="button"
              onClick={() => {
                setFocusedSpeaker(null)
                applyFocusMode(room, null)
              }}
            >
              Auto — Hear Everyone
            </button>
          )}

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