import express from 'express'
import {
  AccessToken,
  RoomServiceClient,
} from 'livekit-server-sdk'

const app = express()

app.use(express.json())

const livekitUrl = process.env.VITE_LIVEKIT_URL
const apiKey = process.env.LIVEKIT_API_KEY
const apiSecret = process.env.LIVEKIT_API_SECRET

const livekitHttpUrl = livekitUrl
  ?.replace('wss://', 'https://')
  .replace('ws://', 'http://')

const roomService = new RoomServiceClient(
  livekitHttpUrl,
  apiKey,
  apiSecret
)

// Vercel exposes this function at /api/index.
// GET /api/index creates a LiveKit participant token.
app.get('/api/index', async (req, res) => {
  try {
    if (!apiKey || !apiSecret || !livekitUrl) {
      return res.status(500).json({
        error: 'LiveKit environment variables are missing',
      })
    }

    const room =
      typeof req.query.room === 'string'
        ? req.query.room
        : 'wegn-hear-test'

    const identity =
      typeof req.query.identity === 'string'
        ? req.query.identity
        : `listener-${Date.now()}`

    const token = new AccessToken(
      apiKey,
      apiSecret,
      { identity }
    )

    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    })

    res.json({
      token: await token.toJwt(),
      room,
      identity,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      error: 'Could not create token',
    })
  }
})

// POST /api/index with { action: 'end-room', room: '...' }
// ends the LiveKit conversation.
app.post('/api/index', async (req, res) => {
  try {
    const { action, room } = req.body ?? {}

    if (action !== 'end-room') {
      return res.status(400).json({
        error: 'Invalid action',
      })
    }

    if (
      typeof room !== 'string' ||
      !room.startsWith('wegn-hear-')
    ) {
      return res.status(400).json({
        error: 'Invalid room',
      })
    }

    await roomService.deleteRoom(room)

    res.json({
      success: true,
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      error: 'Could not end conversation',
    })
  }
})

export default app