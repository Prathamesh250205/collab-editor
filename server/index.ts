import http from 'node:http'
import path from 'node:path'
import { existsSync } from 'node:fs'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { Rooms } from './rooms.ts'

export type ServerOptions = { port: number }

export async function startServer(opts: ServerOptions) {
  const rooms = new Rooms()
  const app = express()
  app.use(express.json())
  app.get('/api/health', (_req, res) => { res.json({ ok: true }) })

  // In production the built React app is served from the same port.
  const dist = path.resolve(import.meta.dirname, '../dist')
  if (existsSync(dist)) {
    app.use(express.static(dist))
    app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')))
  }

  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer: true })

  // WebSocket URL: /ws/<docId>. The doc id is the shareable part of the link.
  server.on('upgrade', (req, socket, head) => {
    const match = new URL(req.url ?? '', 'http://x').pathname.match(/^\/ws\/([\w-]{1,64})$/)
    if (!match) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
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
    async close() {
      clearInterval(pinger)
      for (const ws of wss.clients) ws.terminate()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
