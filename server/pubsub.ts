// Redis pub/sub between server instances. Each open document has a channel
// `doc:<id>`. An instance publishes its own clients' changes there and applies
// what other instances publish. Redis does not store anything here; Postgres does.
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export const UPDATE = 0 // a document update
export const AWARENESS = 1 // cursor/presence update
export const HELLO = 2 // "I just opened this doc, send me what you have" (payload = my state vector)

type Handler = (kind: number, payload: Uint8Array) => void

export class PubSub {
  readonly id = randomUUID() // lets us ignore our own messages
  private pub: Redis
  private sub: Redis // a subscribed Redis connection can't publish, so we need two
  private handlers = new Map<string, Handler>()
  private closed = false

  constructor(url: string) {
    this.pub = new Redis(url)
    this.sub = new Redis(url)
    this.sub.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      const decoder = decoding.createDecoder(message)
      if (decoding.readVarString(decoder) === this.id) return
      const kind = decoding.readVarUint(decoder)
      this.handlers.get(channel.toString())?.(kind, decoding.readVarUint8Array(decoder))
    })
  }

  async subscribe(docId: string, handler: Handler) {
    this.handlers.set(`doc:${docId}`, handler)
    await this.sub.subscribe(`doc:${docId}`)
  }

  async unsubscribe(docId: string) {
    this.handlers.delete(`doc:${docId}`)
    await this.sub.unsubscribe(`doc:${docId}`)
  }

  publish(docId: string, kind: number, payload: Uint8Array) {
    if (this.closed) return // shutting down: sockets closing late still try to publish their cursor removal
    const encoder = encoding.createEncoder()
    encoding.writeVarString(encoder, this.id)
    encoding.writeVarUint(encoder, kind)
    encoding.writeVarUint8Array(encoder, payload)
    this.pub.publish(`doc:${docId}`, Buffer.from(encoding.toUint8Array(encoder))).catch(err => console.error('redis publish failed', err))
  }

  async close() {
    this.closed = true
    await Promise.all([this.pub.quit(), this.sub.quit()])
  }
}
