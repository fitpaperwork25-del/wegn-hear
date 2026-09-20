import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import {
  AccessToken,
  RoomServiceClient,
} from 'livekit-server-sdk'

dotenv.config({ path: '.env.local' })

const app = express()

app.use(cors())
app.use(express.json())

const livekitHttpUrl = process.env.VITE_LIVEKIT_URL
  ?.replace('wss://', 'https://')
  .replace('ws://', 'http://')

const roomService = new RoomServiceClient(
  livekitHttpUrl,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
)

app.get('/token', async (req, res) => {
  try {
    const room = req.query.room || 'wegn-hear-test'
    const identity =
      req.query.identity || `listener-${Date.now()}`

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
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

app.post('/end-room', async (req, res) => {
  try {
    const { room } = req.body

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

app.listen(3001, () => {
  console.log(
    'WEGN Hear token server running on http://localhost:3001'
  )
})