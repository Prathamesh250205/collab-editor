import http from 'node:http'
import path from 'node:path'
import { existsSync } from 'node:fs'
import express, { type RequestHandler } from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { Rooms } from './rooms.ts'
import { Store } from './store.ts'
import { PubSub } from './pubsub.ts'
import { hashPassword, checkPassword, signToken, verifyToken } from './auth.ts'

export type ServerOptions = {
  port: number
  databaseUrl: string
  redisUrl?: string // without it the server runs as a single instance
  authSecret: string // signs login tokens
  saveIntervalMs?: number
  versionIntervalMs?: number
}

const DOC_ID = /^[\w-]{1,64}$/
const USERNAME = /^[\w-]{3,32}$/

export async function startServer(opts: ServerOptions) {
  const store = await Store.connect(opts.databaseUrl)
  const pubsub = opts.redisUrl ? new PubSub(opts.redisUrl) : undefined
  const rooms = new Rooms({
    store,
    pubsub,
    saveIntervalMs: opts.saveIntervalMs ?? 2_000,
    versionIntervalMs: opts.versionIntervalMs ?? 60_000,
  })
  const app = express()
  app.use(express.json())
  app.get('/api/health', (_req, res) => { res.json({ ok: true }) })

  app.post('/api/register', async (req, res) => {
    const { username, password } = req.body ?? {}
    if (typeof username !== 'string' || !USERNAME.test(username)) return void res.status(400).json({ error: 'username: 3-32 letters, digits, _ or -' })
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return void res.status(400).json({ error: 'password: at least 8 characters' })
    if (!(await store.createUser(username, await hashPassword(password)))) return void res.status(409).json({ error: 'username taken' })
    res.json({ username, token: signToken(username, opts.authSecret) })
  })
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body ?? {}
    const hash = typeof username === 'string' ? await store.passwordHash(username) : null
    if (!hash || typeof password !== 'string' || !(await checkPassword(password, hash))) return void res.status(401).json({ error: 'wrong username or password' })
    res.json({ username, token: signToken(username, opts.authSecret) })
  })

  // Everything below needs "Authorization: Bearer <token>".
  const requireAuth: RequestHandler<any> = (req, res, next) => {
    const user = verifyToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '', opts.authSecret)
    if (!user) return void res.status(401).end()
    next()
  }

  app.get('/api/docs/:id/versions', requireAuth, async (req, res) => {
    if (!DOC_ID.test(req.params.id)) return void res.status(400).end()
    res.json(await store.listVersions(req.params.id))
  })
  app.get('/api/docs/:id/versions/:vid', requireAuth, async (req, res) => {
    const text = DOC_ID.test(req.params.id) ? await store.versionText(req.params.id, Number(req.params.vid)) : null
    if (text === null) return void res.status(404).end()
    res.json({ text })
  })

  // In production the built React app is served from the same port.
  const dist = path.resolve(import.meta.dirname, '../dist')
  if (existsSync(dist)) {
    app.use(express.static(dist))
    app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')))
  }

  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer: true })

  // WebSocket URL: /ws/<docId>?token=<token>. The doc id is the shareable part of the link.
  // Browsers can't set headers on a WebSocket, so the token travels in the query string.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://x')
    const match = url.pathname.match(/^\/ws\/([\w-]{1,64})$/)
    if (!match) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (!verifyToken(url.searchParams.get('token') ?? '', opts.authSecret)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      watchAlive(ws)
      rooms.connect(ws, match[1])
    })
  })

  // Dead connections (laptop lid closed, wifi gone) never send "close". Ping every
  // 30s and drop sockets that did not answer, so their cursors disappear.
  const alive = new WeakSet<WebSocket>()
  function watchAlive(ws: WebSocket) {
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
  }
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.delete(ws)) ws.terminate()
      else ws.ping()
    }
  }, 30_000)

  await new Promise<void>(resolve => server.listen(opts.port, resolve))
  const port = (server.address() as { port: number }).port

  return {
    port,
    rooms,
    pubsub,
    async close() {
      clearInterval(pinger)
      for (const ws of wss.clients) ws.terminate()
      await new Promise(resolve => server.close(resolve))
      await rooms.closeAll()
      await store.close()
      await pubsub?.close()
    },
  }
}
