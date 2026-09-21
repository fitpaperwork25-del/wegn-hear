import { useEffect, useRef, useState } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  RemoteAudioTrack,
  RemoteParticipant,
  LocalAudioTrack,
  DisconnectReason,
  createLocalAudioTrack,
} from 'livekit-client'

import './App.css'

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL

const IS_LOCAL = window.location.hostname === 'localhost'

const TOKEN_ENDPOINT = IS_LOCAL
  ? 'http://localhost:3001/token'
  : '/api/index?action=token'

const END_ROOM_ENDPOINT = IS_LOCAL
  ? 'http://localhost:3001/end-room'
  : '/api/index?action=end-room'

const ROOM_PREFIX = 'wegn-hear-'
const AUTO_HOLD_MS = 800

type SpeakerInfo = {
  identity: string
  name: string
}

function App() {
  const [status, setStatus] = useState('Start a conversation')
  const [room, setRoom] = useState<Room | null>(null)

  const [role, setRole] =
    useState<'listener' | 'speaker' | null>(null)

  const [conversationId, setConversationId] = useState('')
  const [speakerName, setSpeakerName] = useState('')
  const [microphoneMuted, setMicrophoneMuted] =
    useState(false)
  const [speakers, setSpeakers] = useState<SpeakerInfo[]>([])

  const [mode, setMode] =
    useState<'auto' | 'focus'>('auto')

  const [focusedSpeaker, setFocusedSpeaker] =
    useState<string | null>(null)

  const [autoSpeaker, setAutoSpeaker] =
    useState<string | null>(null)

  const [activeSpeakers, setActiveSpeakers] =
    useState<Set<string>>(new Set())

  const [speakerVolumes, setSpeakerVolumes] = useState<
    Record<string, number>
  >({})

  const [mutedSpeakers, setMutedSpeakers] = useState<
    Record<string, boolean>
  >({})

  const [copied, setCopied] = useState(false)

  const [conversationEnded, setConversationEnded] =
    useState(false)

  const audioElements = useRef<Map<string, HTMLAudioElement>>(
    new Map()
  )
  const microphoneTrackRef = useRef<LocalAudioTrack | null>(
    null
  )

  const modeRef = useRef<'auto' | 'focus'>('auto')
  const focusedSpeakerRef = useRef<string | null>(null)
  const autoSpeakerRef = useRef<string | null>(null)
  const speakerVolumesRef = useRef<Record<string, number>>({})
  const mutedSpeakersRef = useRef<Record<string, boolean>>({})
  const autoHoldTimer = useRef<number | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const joinId = params.get('join')

    if (joinId) {
      setConversationId(joinId)
      setRole('speaker')
      setStatus('Ready to join conversation')
    }
  }, [])

  function setCurrentMode(nextMode: 'auto' | 'focus') {
    modeRef.current = nextMode
    setMode(nextMode)
  }

  function setCurrentFocus(identity: string | null) {
    focusedSpeakerRef.current = identity
    setFocusedSpeaker(identity)
  }

  function setCurrentAutoSpeaker(identity: string | null) {
    autoSpeakerRef.current = identity
    setAutoSpeaker(identity)
  }

  function clearAutoHoldTimer() {
    if (autoHoldTimer.current !== null) {
      window.clearTimeout(autoHoldTimer.current)
      autoHoldTimer.current = null
    }
  }

  async function getToken(
    roomName: string,
    identity: string
  ) {
    const separator = TOKEN_ENDPOINT.includes('?') ? '&' : '?'

    const response = await fetch(
      `${TOKEN_ENDPOINT}${separator}room=${encodeURIComponent(
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

      speakerVolumesRef.current = next
      return next
    })

    setMutedSpeakers((current) => {
      const next = { ...current }

      list.forEach((speaker) => {
        if (next[speaker.identity] === undefined) {
          next[speaker.identity] = false
        }
      })

      mutedSpeakersRef.current = next
      return next
    })
  }

  function applySpeakerAudio(
    targetIdentity: string | null,
    volumes: Record<string, number>,
    muted: Record<string, boolean>
  ) {
    audioElements.current.forEach((element, identity) => {
      const shouldHear =
        targetIdentity === null ||
        targetIdentity === identity

      const isMuted = muted[identity] ?? false
      const volume = volumes[identity] ?? 100

      element.muted = !shouldHear || isMuted

      element.volume = Math.max(
        0,
        Math.min(1, volume / 100)
      )
    })
  }

  function applyCurrentListeningMode() {
    if (modeRef.current === 'focus') {
      applySpeakerAudio(
        focusedSpeakerRef.current,
        speakerVolumesRef.current,
        mutedSpeakersRef.current
      )

      return
    }

    applySpeakerAudio(
      autoSpeakerRef.current,
      speakerVolumesRef.current,
      mutedSpeakersRef.current
    )
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

      speakerVolumesRef.current = nextVolumes

      setMutedSpeakers((currentMuted) => {
        const nextMuted = {
          ...currentMuted,
          [identity]: currentMuted[identity] ?? false,
        }

        mutedSpeakersRef.current = nextMuted

        window.setTimeout(() => {
          applyCurrentListeningMode()
        }, 0)

        return nextMuted
      })

      return nextVolumes
    })
  }

  function handleActiveSpeakers(
    participants: RemoteParticipant[]
  ) {
    const speakerParticipants = participants.filter(
      (participant) =>
        participant.identity.startsWith('speaker-')
    )

    setActiveSpeakers(
      new Set(
        speakerParticipants.map(
          (participant) => participant.identity
        )
      )
    )

    if (modeRef.current !== 'auto') {
      return
    }

    const strongestSpeaker =
      speakerParticipants[0]?.identity ?? null

    if (!strongestSpeaker) {
      return
    }

    if (strongestSpeaker === autoSpeakerRef.current) {
      return
    }

    clearAutoHoldTimer()

    autoHoldTimer.current = window.setTimeout(() => {
      if (modeRef.current !== 'auto') {
        return
      }

      setCurrentAutoSpeaker(strongestSpeaker)

      applySpeakerAudio(
        strongestSpeaker,
        speakerVolumesRef.current,
        mutedSpeakersRef.current
      )

      autoHoldTimer.current = null
    }, AUTO_HOLD_MS)
  }

  async function startConversation() {
    try {
      setConversationEnded(false)
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

      newRoom.on(
        RoomEvent.ActiveSpeakersChanged,
        (participants) => {
          handleActiveSpeakers(
            participants.filter(
              (participant) =>
                participant instanceof RemoteParticipant
            )
          )
        }
      )

      newRoom.on(RoomEvent.ParticipantConnected, () => {
        updateSpeakerList(newRoom)
      })

      newRoom.on(
        RoomEvent.ParticipantDisconnected,
        (participant) => {
          const element = audioElements.current.get(
            participant.identity
          )

          if (element) {
            element.remove()
            audioElements.current.delete(participant.identity)
          }

          updateSpeakerList(newRoom)

          setActiveSpeakers((current) => {
            const next = new Set(current)
            next.delete(participant.identity)
            return next
          })

          if (
            focusedSpeakerRef.current === participant.identity
          ) {
            setCurrentFocus(null)
            setCurrentMode('auto')
          }

          if (
            autoSpeakerRef.current === participant.identity
          ) {
            setCurrentAutoSpeaker(null)
          }

          window.setTimeout(() => {
            applyCurrentListeningMode()
          }, 0)
        }
      )

      await newRoom.connect(LIVEKIT_URL, token)
      await newRoom.startAudio()

      setCurrentMode('auto')
      setCurrentFocus(null)
      setCurrentAutoSpeaker(null)

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
      setConversationEnded(false)
      setStatus('Joining conversation...')

      const roomName = `${ROOM_PREFIX}${conversationId}`

      const identity =
        `speaker-${encodeURIComponent(
          cleanName
        )}-${crypto.randomUUID()}`

      const token = await getToken(roomName, identity)

      const newRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
      })

      newRoom.on(
        RoomEvent.Disconnected,
        (reason) => {
          if (reason === DisconnectReason.ROOM_DELETED) {
            setRoom(null)
            setConversationEnded(true)
            setStatus('Conversation ended')
          }
        }
      )

      await newRoom.connect(LIVEKIT_URL, token)

      const microphoneTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      })

      await newRoom.localParticipant.publishTrack(
        microphoneTrack,
        {
          source: Track.Source.Microphone,
          dtx: true,
          red: true,
        }
      )

      microphoneTrackRef.current = microphoneTrack

      setRoom(newRoom)
      setRole('speaker')
      setMicrophoneMuted(false)

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
    clearAutoHoldTimer()

    setCurrentMode('focus')
    setCurrentFocus(identity)

    applySpeakerAudio(
      identity,
      speakerVolumesRef.current,
      mutedSpeakersRef.current
    )
  }

  function autoMode() {
    clearAutoHoldTimer()

    setCurrentMode('auto')
    setCurrentFocus(null)

    applySpeakerAudio(
      autoSpeakerRef.current,
      speakerVolumesRef.current,
      mutedSpeakersRef.current
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

      speakerVolumesRef.current = next

      applyCurrentListeningMode()

      return next
    })
  }

  function toggleSpeakerMute(identity: string) {
    setMutedSpeakers((current) => {
      const next = {
        ...current,
        [identity]: !(current[identity] ?? false),
      }

      mutedSpeakersRef.current = next

      applyCurrentListeningMode()

      return next
    })
  }

  function resetLocalConversation() {
    clearAutoHoldTimer()

    audioElements.current.forEach((element) => {
      element.remove()
    })

    audioElements.current.clear()

    modeRef.current = 'auto'
    focusedSpeakerRef.current = null
    autoSpeakerRef.current = null
    speakerVolumesRef.current = {}
    mutedSpeakersRef.current = {}
    microphoneTrackRef.current = null

    setRoom(null)
    setRole(null)
    setSpeakers([])
    setMode('auto')
    setFocusedSpeaker(null)
    setAutoSpeaker(null)
    setActiveSpeakers(new Set())
    setSpeakerVolumes({})
    setMutedSpeakers({})
    setConversationId('')
    setSpeakerName('')
    setMicrophoneMuted(false)
    setCopied(false)
    setConversationEnded(false)
    setStatus('Start a conversation')

    window.history.replaceState({}, '', '/')
  }

  async function leave() {
    await room?.disconnect()
    resetLocalConversation()
  }

  async function toggleMicrophone() {
    const track = microphoneTrackRef.current

    if (!track) {
      return
    }

    if (microphoneMuted) {
      await track.resumeUpstream()
      setMicrophoneMuted(false)
      return
    }

    await track.pauseUpstream()
    setMicrophoneMuted(true)
  }

  async function endConversation() {
    if (!conversationId) {
      return
    }

    try {
      setStatus('Ending conversation...')

      const roomName = `${ROOM_PREFIX}${conversationId}`

      const response = await fetch(
        END_ROOM_ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
          action: 'end-room',
            room: roomName,
          }),
        }
      )

      if (!response.ok) {
        throw new Error('End conversation request failed')
      }

      resetLocalConversation()
    } catch (error) {
      console.error(error)
      setStatus('Could not end conversation')
    }
  }

  if (role === 'speaker' && conversationEnded) {
    return (
      <main>
        <h1>WEGN Hear</h1>

        <p>HD Audio</p>

        <h2>Conversation ended</h2>

        <p>The listener ended this conversation.</p>
      </main>
    )
  }

  if (role === 'speaker' && !room) {
    return (
      <main>
        <h1>WEGN Hear</h1>

        <p>HD Audio</p>

        <h2>You've been invited to speak</h2>

        <p>
          Enter your name, then join the conversation.
        </p>

        <input
          type="text"
          placeholder="Your name"
          value={speakerName}
          onChange={(event) =>
            setSpeakerName(event.target.value)
          }
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              speakerName.trim()
            ) {
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

        <button
          type="button"
          onClick={toggleMicrophone}
        >
          {microphoneMuted
            ? 'Unmute My Microphone'
            : 'Mute My Microphone'}
        </button>

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

        <p>
          Mode:{' '}
          <strong>
            {mode === 'auto' ? 'Auto' : 'Focus'}
          </strong>
        </p>

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
                mode === 'focus' &&
                focusedSpeaker === speaker.identity

              const isAutoSelected =
                mode === 'auto' &&
                autoSpeaker === speaker.identity

              const isSpeaking =
                activeSpeakers.has(speaker.identity)

              return (
                <li key={speaker.identity}>
                  <strong>{speaker.name}</strong>{' '}

                  {isSpeaking && (
                    <>
                      <strong>Speaking ●</strong>{' '}
                    </>
                  )}

                  {isAutoSelected && (
                    <>
                      <strong>Auto ✓</strong>{' '}
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() =>
                      focusSpeaker(speaker.identity)
                    }
                  >
                    {isFocused
                      ? 'Focused ✓'
                      : 'Focus'}
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
          <button
            type="button"
            onClick={autoMode}
            disabled={mode === 'auto'}
          >
            {mode === 'auto'
              ? 'Auto Mode ✓'
              : 'Return to Auto'}
          </button>
        )}

        <h2>Invite a speaker</h2>

        <p>
          Send this link to anyone you want to hear.
        </p>

        <button
          type="button"
          onClick={copySpeakerLink}
        >
          {copied
            ? 'Link Copied ✓'
            : 'Copy Speaker Link'}
        </button>{' '}

        <button
          type="button"
          onClick={endConversation}
        >
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
