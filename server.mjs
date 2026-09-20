import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { AccessToken } from 'livekit-server-sdk'

dotenv.config({ path: '.env.local' })

const app = express()

app.use(cors())
app.use(express.json())

app.get('/token', async (req, res) => {
  try {
    const room = req.query.room || 'wegn-hear-test'
    const identity = req.query.identity || `listener-${Date.now()}`

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
    res.status(500).json({ error: 'Could not create token' })
  }
})

app.listen(3001, () => {
  console.log('WEGN Hear token server running on http://localhost:3001')
})