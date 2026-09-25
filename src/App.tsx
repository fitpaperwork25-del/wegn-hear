import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
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
const LISTENER_GAIN = 5.0

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
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('')
  const [showQrCode, setShowQrCode] = useState(false)

  const [conversationEnded, setConversationEnded] =
    useState(false)

  const audioElements = useRef<Map<string, HTMLAudioElement>>(
    new Map()
  )
  const audioNodes = useRef<
    Map<
      string,
      {
        track: RemoteAudioTrack
        source: MediaElementAudioSourceNode
        gain: GainNode
        compressor: DynamicsCompressorNode
      }
    >
  >(new Map())
  const listenerAudioContext = useRef<AudioContext | null>(
    null
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

  function removeAudioTrack(identity: string) {
    const element = audioElements.current.get(identity)
    const nodes = audioNodes.current.get(identity)

    if (nodes && element) {
      nodes.track.detach(element)
      nodes.source.disconnect()
      nodes.gain.disconnect()
      nodes.compressor.disconnect()
      audioNodes.current.delete(identity)
    }

    if (element) {
      element.remove()
      audioElements.current.delete(identity)
    }
  }

  function attachAudioTrack(
    track: RemoteAudioTrack,
    participant: RemoteParticipant
  ) {
    const identity = participant.identity
    removeAudioTrack(identity)

    const element = track.attach()

    element.autoplay = true
    element.setAttribute('playsinline', 'true')

    const audioContext =
      listenerAudioContext.current ??
      (listenerAudioContext.current = new AudioContext())
    const source = audioContext.createMediaElementSource(
      element
    )
    const gain = audioContext.createGain()
    const compressor = audioContext.createDynamicsCompressor()

    gain.gain.value = LISTENER_GAIN
    compressor.threshold.value = -24
    compressor.knee.value = 12
    compressor.ratio.value = 8
    compressor.attack.value = 0.003
    compressor.release.value = 0.25

    source.connect(gain)
    gain.connect(compressor)
    compressor.connect(audioContext.destination)
    void audioContext.resume()

    document.body.appendChild(element)
    audioElements.current.set(identity, element)
    audioNodes.current.set(identity, {
      track,
      source,
      gain,
      compressor,
    })

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
          removeAudioTrack(participant.identity)

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
      setStatus('Conversation live âœ“')

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
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      })

      await newRoom.localParticipant.publishTrack(
        microphoneTrack,
        {
          source: Track.Source.Microphone,
          dtx: true,
          red: false,
        }
      )

      microphoneTrackRef.current = microphoneTrack

      setRoom(newRoom)
      setRole('speaker')
      setMicrophoneMuted(false)

      setStatus(`${cleanName} â€” microphone live âœ“`)
    } catch (error) {
      console.error(error)
      setStatus('Could not join conversation')
    }
  }

  function getSpeakerLink() {
    if (!conversationId) {
      return ''
    }

    return `${window.location.origin}/?join=${encodeURIComponent(
        conversationId
      )}`
  }

  async function copySpeakerLink() {
    const link = getSpeakerLink()

    if (!link) {
      return
    }

    await navigator.clipboard.writeText(link)

    setCopied(true)

    window.setTimeout(() => {
      setCopied(false)
    }, 2000)
  }

  async function openQrCode() {
    const link = getSpeakerLink()

    if (!link) {
      return
    }

    const dataUrl = await QRCode.toDataURL(link, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    })

    setQrCodeDataUrl(dataUrl)
    setShowQrCode(true)
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

    audioElements.current.forEach((_element, identity) => {
      removeAudioTrack(identity)
    })

    audioNodes.current.clear()
    void listenerAudioContext.current?.close()
    listenerAudioContext.current = null

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
    setQrCodeDataUrl('')
    setShowQrCode(false)
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
      <main className="speaker-view speaker-ended-view">
        <div className="speaker-shell speaker-ended-shell">
          <img
            className="official-logo"
            src="/images/logo.png"
            alt="WEGN"
          />
          <p className="product-label">WEGN Hear</p>
          <p className="product-audio-label">HD Audio</p>
          <div className="speaker-ended-mark" aria-hidden="true">
            âœ“
          </div>
          <h1>Conversation ended</h1>
          <p className="speaker-message">
            The listener ended this conversation.
          </p>
        </div>
      </main>
    )
  }

  if (role === 'speaker' && !room) {
    return (
      <main className="speaker-view speaker-join-view">
        <div className="speaker-shell">
          <header className="speaker-branding">
            <img
              className="official-logo"
              src="/images/logo.png"
              alt="WEGN"
            />
            <div>
              <p className="product-label">WEGN Hear</p>
              <p className="product-audio-label">HD Audio</p>
            </div>
          </header>

          <section className="speaker-card speaker-intro-card">
            <p className="speaker-kicker">PRIVATE INVITATION</p>
            <h1>You've been invited to speak.</h1>
            <p className="speaker-message">
              Your voice will be sent directly to the listener in this conversation.
            </p>

            <label className="speaker-name-label" htmlFor="speaker-name">
              Your name
            </label>
            <input
              id="speaker-name"
              className="speaker-name-input"
              type="text"
              placeholder="Enter your name"
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
              className="speaker-primary-button"
              type="button"
              onClick={joinConversation}
              disabled={!speakerName.trim()}
            >
              Join Conversation
            </button>

            <p className="speaker-status">{status}</p>
          </section>
        </div>
      </main>
    )
  }

  if (role === 'speaker' && room) {
    return (
      <main className="speaker-view speaker-live-view">
        <div className="speaker-shell">
          <header className="speaker-branding">
            <img
              className="official-logo"
              src="/images/logo.png"
              alt="WEGN"
            />
            <div>
              <p className="product-label">WEGN Hear</p>
              <p className="product-audio-label">HD Audio</p>
            </div>
          </header>

          <section className={`speaker-card speaker-live-card${
            microphoneMuted ? ' is-muted' : ''
          }`}>
            <div className="live-status-row">
              <span className="live-status-dot" aria-hidden="true" />
              <span>{microphoneMuted ? 'Microphone muted' : 'Microphone live'}</span>
            </div>
            <p className="speaker-kicker">YOU ARE SPEAKING AS</p>
            <h1>{speakerName}</h1>
            <p className="speaker-message">
              {microphoneMuted
                ? 'Your microphone is muted. Unmute when you are ready to continue.'
                : 'The listener can hear you now.'}
            </p>

            <button
              className="speaker-microphone-button"
              type="button"
              onClick={toggleMicrophone}
            >
              <span className="microphone-icon" aria-hidden="true">
                {microphoneMuted ? 'â—‹' : 'â—'}
              </span>
              {microphoneMuted
                ? 'Unmute My Microphone'
                : 'Mute My Microphone'}
            </button>
          </section>

          <p className="speaker-live-status">{status}</p>

          <button
            className="speaker-leave-button"
            type="button"
            onClick={leave}
          >
            Leave Conversation
          </button>
        </div>
      </main>
    )
  }

  if (role === 'listener' && room) {
    return (
      <main className="listener-view">
        <div className="listener-shell">
          <header className="listener-header">
            <div className="brand-lockup">
              <img
                className="listener-logo"
                src="/images/logo.png"
                alt="WEGN"
              />
              <div>
                <h1>WEGN Hear</h1>
                <p className="brand-subtitle">HD Audio</p>
              </div>
            </div>

            <div className="connection-status" role="status">
              <span className="status-dot" aria-hidden="true" />
              <span>{status}</span>
            </div>
          </header>

          <section className="mode-panel" aria-labelledby="mode-title">
            <div className="section-heading">
              <div>
                <p className="section-kicker">LISTENING MODE</p>
                <h2 id="mode-title">Choose how you listen</h2>
              </div>
              <strong className="mode-badge">
                {mode === 'auto' ? 'Auto' : 'Focus'}
              </strong>
            </div>

            {speakers.length > 0 && (
              <button
                className="mode-button"
                type="button"
                onClick={autoMode}
                disabled={mode === 'auto'}
              >
                <span className="mode-button-icon" aria-hidden="true">
                  â—‰
                </span>
                {mode === 'auto'
                  ? 'Auto Mode âœ“'
                  : 'Return to Auto'}
              </button>
            )}
          </section>

          <section className="speakers-section" aria-labelledby="speakers-title">
            <div className="section-heading speakers-heading">
              <div>
                <p className="section-kicker">LIVE CHANNELS</p>
                <h2 id="speakers-title">Connected Speakers</h2>
              </div>
              <span className="speaker-count">
                {speakers.length.toString().padStart(2, '0')}
              </span>
            </div>

            {speakers.length === 0 ? (
              <div className="empty-speakers">
                <span className="empty-icon" aria-hidden="true">â—Œ</span>
                <p>Waiting for speakers...</p>
              </div>
            ) : (
              <ul className="speaker-list">
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
                <li
                  className={`speaker-card${
                    isSpeaking ? ' is-speaking' : ''
                  }${
                    isFocused || isAutoSelected
                      ? ' is-selected'
                      : ''
                  }`}
                  key={speaker.identity}
                >
                  <div className="speaker-card-topline">
                    <div className="speaker-identity">
                      <span className="speaker-avatar" aria-hidden="true">
                        {speaker.name.charAt(0).toUpperCase()}
                      </span>
                      <div>
                        <strong>{speaker.name}</strong>
                        <div className="speaker-state">
                          {isSpeaking ? (
                            <span className="speaking-state">
                              <span className="signal-bars" aria-hidden="true" />
                              Speaking now
                            </span>
                          ) : (
                            'Connected'
                          )}
                        </div>
                      </div>
                    </div>

                    {(isFocused || isAutoSelected) && (
                      <span className="selection-badge">
                        {isFocused ? 'Focused âœ“' : 'Auto âœ“'}
                      </span>
                    )}
                  </div>

                  <div className="speaker-card-controls">
                    <button
                      className={`focus-button${
                        isFocused ? ' is-active' : ''
                      }`}
                      type="button"
                      onClick={() =>
                        focusSpeaker(speaker.identity)
                      }
                    >
                      {isFocused ? 'Focused âœ“' : 'Focus'}
                    </button>

                    <button
                      className={`mute-button${
                        isMuted ? ' is-muted' : ''
                      }`}
                      type="button"
                      onClick={() =>
                        toggleSpeakerMute(speaker.identity)
                      }
                    >
                      {isMuted ? 'Unmute' : 'Mute'}
                    </button>

                    <div className="volume-control">
                      <button
                        className="volume-button"
                        type="button"
                        aria-label={`Decrease ${speaker.name} volume`}
                        onClick={() =>
                          changeSpeakerVolume(
                            speaker.identity,
                            -10
                          )
                        }
                      >
                        âˆ’
                      </button>
                      <span className="volume-value">{volume}%</span>
                      <button
                        className="volume-button"
                        type="button"
                        aria-label={`Increase ${speaker.name} volume`}
                        onClick={() =>
                          changeSpeakerVolume(
                            speaker.identity,
                            10
                          )
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
              </ul>
            )}
          </section>

          <section className="invite-panel" aria-labelledby="invite-title">
            <div>
              <h2 id="invite-title">INVITE A SPEAKER</h2>
              <p>Share a private link to join.</p>
            </div>
            <button
              className="invite-button"
              type="button"
              onClick={copySpeakerLink}
            >
              <span aria-hidden="true">ï¼‹</span>
              {copied ? 'Link Copied âœ“' : 'Copy Speaker Link'}
            </button>
            <button
              className="qr-button"
              type="button"
              onClick={openQrCode}
            >
              <span aria-hidden="true">â–¦</span>
              Show QR Code
            </button>
          </section>

          <button
            className="end-button"
            type="button"
            onClick={endConversation}
          >
            End Conversation
          </button>
        </div>

        {showQrCode && qrCodeDataUrl && (
          <div
            className="qr-modal-backdrop"
            role="presentation"
            onClick={() => setShowQrCode(false)}
          >
            <section
              className="qr-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="qr-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className="qr-close-button"
                type="button"
                aria-label="Close QR code"
                onClick={() => setShowQrCode(false)}
              >
                Ã—
              </button>
              <p className="section-kicker">SPEAKER INVITATION</p>
              <h2 id="qr-modal-title">Scan to join</h2>
              <p className="qr-supporting-text">
                Scan this code to join the conversation as a speaker.
              </p>
              <div className="qr-code-frame">
                <img
                  src={qrCodeDataUrl}
                  alt="QR code for joining this conversation as a speaker"
                />
              </div>
              <button
                className="qr-modal-close-action"
                type="button"
                onClick={() => setShowQrCode(false)}
              >
                Close
              </button>
            </section>
          </div>
        )}
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
