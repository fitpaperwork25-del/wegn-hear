import { useEffect, useRef, useState } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  RemoteAudioTrack,
  RemoteParticipant,
  createLocalAudioTrack,
} from 'livekit-client'

import './App.css'

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVER = 'http://localhost:3001'
const ROOM_PREFIX = 'wegn-hear-'

type SpeakerInfo = {
  identity: string
  name: string
}

function App() {
  const [status, setStatus] = useState('Start a conversation')
  const [room, setRoom] = useState<Room | null>(null)
  const [role, setRole] = useState<'listener' | 'speaker' | null>(null)

  const [conversationId, setConversationId] = useState('')
  const [speakerName, setSpeakerName] = useState('')
  const [speakers, setSpeakers] = useState<SpeakerInfo[]>([])

  const [focusedSpeaker, setFocusedSpeaker] = useState<string | null>(null)

  const [speakerVolumes, setSpeakerVolumes] = useState<
    Record<string, number>
  >({})

  const [mutedSpeakers, setMutedSpeakers] = useState<
    Record<string, boolean>
  >({})

  const [copied, setCopied] = useState(false)

  const audioElements = useRef<Map<string, HTMLAudioElement>>(new Map())

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const joinId = params.get('join')

    if (joinId) {
      setConversationId(joinId)
      setRole('speaker')
      setStatus('Ready to join conversation')
    }
  }, [])

  async function getToken(roomName: string, identity: string) {
    const response = await fetch(
      `${TOKEN_SERVER}/token?room=${encodeURIComponent(
        roomName
      )}&identity=${encodeURIComponent(identity)}`
    )

    if (!response.ok) {
      throw new Error('Token request failed')
    }

    const data = await response.json()
    return data.token
  }

  function getSpeakerName(identity: string) {
    if (!identity.startsWith('speaker-')) {
      return identity
    }

    const withoutPrefix = identity.slice('speaker-'.length)

    // UUID at the end is 36 characters, plus the preceding hyphen.
    const encodedName = withoutPrefix.slice(0, -37)

    try {
      return decodeURIComponent(encodedName)
    } catch {
      return encodedName
    }
  }

  function updateSpeakerList(currentRoom: Room) {
    const list: SpeakerInfo[] = []

    currentRoom.remoteParticipants.forEach((participant) => {
      if (!participant.identity.startsWith('speaker-')) {
        return
      }

      list.push({
        identity: participant.identity,
        name: getSpeakerName(participant.identity),
      })
    })

    setSpeakers(list)

    setSpeakerVolumes((current) => {
      const next = { ...current }

      list.forEach((speaker) => {
        if (next[speaker.identity] === undefined) {
          next[speaker.identity] = 100
        }
      })

      return next
    })

    setMutedSpeakers((current) => {
      const next = { ...current }

      list.forEach((speaker) => {
        if (next[speaker.identity] === undefined) {
          next[speaker.identity] = false
        }
      })

      return next
    })
  }

  function applySpeakerAudio(
    focusIdentity: string | null,
    volumes: Record<string, number>,
    muted: Record<string, boolean>
  ) {
    audioElements.current.forEach((element, identity) => {
      const isFocused =
        focusIdentity === null || focusIdentity === identity

      const isMuted = muted[identity] ?? false
      const volume = volumes[identity] ?? 100

      element.muted = !isFocused || isMuted
      element.volume = Math.max(0, Math.min(1, volume / 100))
    })
  }

  function attachAudioTrack(
    track: RemoteAudioTrack,
    participant: RemoteParticipant
  ) {
    const identity = participant.identity

    const existing = audioElements.current.get(identity)

    if (existing) {
      existing.remove()
      audioElements.current.delete(identity)
    }

    const element = track.attach()

    element.autoplay = true
    element.setAttribute('playsinline', 'true')

    document.body.appendChild(element)

    audioElements.current.set(identity, element)

    setSpeakerVolumes((currentVolumes) => {
      const nextVolumes = {
        ...currentVolumes,
        [identity]: currentVolumes[identity] ?? 100,
      }

      setMutedSpeakers((currentMuted) => {
        const nextMuted = {
          ...currentMuted,
          [identity]: currentMuted[identity] ?? false,
        }

        setFocusedSpeaker((currentFocus) => {
          applySpeakerAudio(currentFocus, nextVolumes, nextMuted)
          return currentFocus
        })

        return nextMuted
      })

      return nextVolumes
    })
  }

  async function startConversation() {
    try {
      setStatus('Starting conversation...')

      const id = crypto.randomUUID()
      const roomName = `${ROOM_PREFIX}${id}`
      const identity = `listener-${crypto.randomUUID()}`

      const token = await getToken(roomName, identity)

      const newRoom = new Room({
        adaptiveStream: true,
      })

      newRoom.on(
        RoomEvent.TrackSubscribed,
        (track, _publication, participant) => {
          if (
            track.kind === Track.Kind.Audio &&
            participant.identity.startsWith('speaker-')
          ) {
            attachAudioTrack(
              track as RemoteAudioTrack,
              participant
            )
          }
        }
      )

      newRoom.on(RoomEvent.ParticipantConnected, () => {
        updateSpeakerList(newRoom)
      })

      newRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        const element = audioElements.current.get(participant.identity)

        if (element) {
          element.remove()
          audioElements.current.delete(participant.identity)
        }

        updateSpeakerList(newRoom)

        setFocusedSpeaker((current) => {
          if (current === participant.identity) {
            return null
          }

          return current
        })
      })

      await newRoom.connect(LIVEKIT_URL, token)
      await newRoom.startAudio()

      setConversationId(id)
      setRoom(newRoom)
      setRole('listener')
      setStatus('Conversation live ✓')

      updateSpeakerList(newRoom)

      window.history.replaceState({}, '', '/')
    } catch (error) {
      console.error(error)
      setStatus('Could not start conversation')
    }
  }

  async function joinConversation() {
    const cleanName = speakerName.trim()

    if (!cleanName || !conversationId) {
      return
    }

    try {
      setStatus('Joining conversation...')

      const roomName = `${ROOM_PREFIX}${conversationId}`

      const identity =
        `speaker-${encodeURIComponent(cleanName)}-${crypto.randomUUID()}`

      const token = await getToken(roomName, identity)

      const newRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
      })

      await newRoom.connect(LIVEKIT_URL, token)

      const microphoneTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      })

      await newRoom.localParticipant.publishTrack(microphoneTrack, {
        source: Track.Source.Microphone,
        dtx: true,
        red: true,
      })

      setRoom(newRoom)
      setRole('speaker')

      setStatus(`${cleanName} — microphone live ✓`)
    } catch (error) {
      console.error(error)
      setStatus('Could not join conversation')
    }
  }

  async function copySpeakerLink() {
    if (!conversationId) {
      return
    }

    const link =
      `${window.location.origin}/?join=${encodeURIComponent(
        conversationId
      )}`

    await navigator.clipboard.writeText(link)

    setCopied(true)

    window.setTimeout(() => {
      setCopied(false)
    }, 2000)
  }

  function focusSpeaker(identity: string) {
    const nextFocus =
      focusedSpeaker === identity ? null : identity

    setFocusedSpeaker(nextFocus)

    applySpeakerAudio(
      nextFocus,
      speakerVolumes,
      mutedSpeakers
    )
  }

  function autoMode() {
    setFocusedSpeaker(null)

    applySpeakerAudio(
      null,
      speakerVolumes,
      mutedSpeakers
    )
  }

  function changeSpeakerVolume(
    identity: string,
    amount: number
  ) {
    setSpeakerVolumes((current) => {
      const currentVolume = current[identity] ?? 100

      const nextVolume = Math.max(
        0,
        Math.min(100, currentVolume + amount)
      )

      const next = {
        ...current,
        [identity]: nextVolume,
      }

      applySpeakerAudio(
        focusedSpeaker,
        next,
        mutedSpeakers
      )

      return next
    })
  }

  function toggleSpeakerMute(identity: string) {
    setMutedSpeakers((current) => {
      const next = {
        ...current,
        [identity]: !(current[identity] ?? false),
      }

      applySpeakerAudio(
        focusedSpeaker,
        speakerVolumes,
        next
      )

      return next
    })
  }

  async function leave() {
    await room?.disconnect()

    audioElements.current.forEach((element) => {
      element.remove()
    })

    audioElements.current.clear()

    setRoom(null)
    setRole(null)
    setSpeakers([])
    setFocusedSpeaker(null)
    setSpeakerVolumes({})
    setMutedSpeakers({})
    setConversationId('')
    setSpeakerName('')
    setCopied(false)
    setStatus('Start a conversation')

    window.history.replaceState({}, '', '/')
  }

  if (role === 'speaker' && !room) {
    return (
      <main>
        <h1>WEGN Hear</h1>

        <p>HD Audio</p>

        <h2>You've been invited to speak</h2>

        <p>Enter your name, then join the conversation.</p>

        <input
          type="text"
          placeholder="Your name"
          value={speakerName}
          onChange={(event) =>
            setSpeakerName(event.target.value)
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter' && speakerName.trim()) {
              joinConversation()
            }
          }}
        />

        <button
          type="button"
          onClick={joinConversation}
          disabled={!speakerName.trim()}
        >
          Join Conversation
        </button>

        <p>{status}</p>
      </main>
    )
  }

  if (role === 'speaker' && room) {
    return (
      <main>
        <h1>WEGN Hear</h1>

        <p>HD Audio</p>

        <p>{status}</p>

        <button type="button" onClick={leave}>
          Leave Conversation
        </button>
      </main>
    )
  }

  if (role === 'listener' && room) {
    return (
      <main>
        <h1>WEGN Hear</h1>

        <p>HD Audio</p>

        <p>{status}</p>

        <h2>Connected Speakers</h2>

        {speakers.length === 0 ? (
          <p>Waiting for speakers...</p>
        ) : (
          <ul>
            {speakers.map((speaker) => {
              const volume =
                speakerVolumes[speaker.identity] ?? 100

              const isMuted =
                mutedSpeakers[speaker.identity] ?? false

              const isFocused =
                focusedSpeaker === speaker.identity

              return (
                <li key={speaker.identity}>
                  <strong>{speaker.name}</strong>{' '}

                  <button
                    type="button"
                    onClick={() =>
                      focusSpeaker(speaker.identity)
                    }
                  >
                    {isFocused ? 'Focused ✓' : 'Focus'}
                  </button>{' '}

                  <button
                    type="button"
                    onClick={() =>
                      toggleSpeakerMute(speaker.identity)
                    }
                  >
                    {isMuted ? 'Unmute' : 'Mute'}
                  </button>{' '}

                  <button
                    type="button"
                    onClick={() =>
                      changeSpeakerVolume(
                        speaker.identity,
                        -10
                      )
                    }
                  >
                    −
                  </button>{' '}

                  {volume}%{' '}

                  <button
                    type="button"
                    onClick={() =>
                      changeSpeakerVolume(
                        speaker.identity,
                        10
                      )
                    }
                  >
                    +
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {speakers.length > 0 && (
          <button type="button" onClick={autoMode}>
            Auto — Hear Everyone
          </button>
        )}

        <h2>Invite a speaker</h2>

        <p>Send this link to anyone you want to hear.</p>

        <button
          type="button"
          onClick={copySpeakerLink}
        >
          {copied ? 'Link Copied ✓' : 'Copy Speaker Link'}
        </button>{' '}

        <button type="button" onClick={leave}>
          End Conversation
        </button>
      </main>
    )
  }

  return (
    <main>
      <h1>WEGN Hear</h1>

      <p>HD Audio</p>

      <button
        type="button"
        onClick={startConversation}
      >
        Start Conversation
      </button>

      <p>{status}</p>
    </main>
  )
}

export default App