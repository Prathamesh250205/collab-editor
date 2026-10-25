// A "room" is one shared document plus everyone connected to it.
// The server keeps its own copy of the Yjs document, so a new client can get
// the full state from the server instead of waiting for another client.
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { WebSocket } from 'ws'
import type { Store } from './store.ts'
import { type PubSub, UPDATE, AWARENESS, HELLO } from './pubsub.ts'

// Message types of the y-websocket wire protocol (the browser's WebsocketProvider speaks it).
const MSG_SYNC = 0
const MSG_AWARENESS = 1

export class Room {
  readonly name: string
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  // Each socket -> the awareness client ids it owns, so we can clear its cursor when it leaves.
  readonly conns = new Map<WebSocket, Set<number>>()
  closed = false
  saver?: Saver

  constructor(name: string) {
    this.name = name
    this.awareness.setLocalState(null) // the server itself has no cursor

    // Any change to the document (from a client) is forwarded to every other client.
    // `origin` is the socket the change came from, so we don't echo it back.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const msg = encoding.toUint8Array(encoder)
      for (const conn of this.conns.keys()) if (conn !== origin) send(conn, msg)
    })

    // Awareness = ephemeral state: cursor position, selection, user name/colour.
    // It is not part of the document and is never saved.
    this.awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const owned = this.conns.get(origin as WebSocket)
      if (owned) {
        added.forEach(id => owned.add(id))
        removed.forEach(id => owned.delete(id))
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MSG_AWARENESS)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed)))
      const msg = encoding.toUint8Array(encoder)
      for (const conn of this.conns.keys()) send(conn, msg)
    })
  }

  join(ws: WebSocket) {
    this.conns.set(ws, new Set())
    // Sync step 1: "here is what I have (state vector), send me what I'm missing".
    // The client answers with step 2 (its missing updates) and sends its own step 1,
    // which we answer in handle(). This two-way exchange is also what merges offline edits.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    send(ws, encoding.toUint8Array(encoder))

    const states = this.awareness.getStates()
    if (states.size > 0) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]))
      send(ws, encoding.toUint8Array(enc))
    }
  }

  handle(ws: WebSocket, message: Uint8Array) {
    const decoder = decoding.createDecoder(message)
    switch (decoding.readVarUint(decoder)) {
      case MSG_SYNC: {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MSG_SYNC)
        // Applies updates with origin = ws, and writes a reply (step 2) when one is needed.
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws)
        if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder))
        break
      }
      case MSG_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws)
        break
    }
  }

  leave(ws: WebSocket) {
    const owned = this.conns.get(ws)
    this.conns.delete(ws)
    if (owned?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...owned], null)
  }

  destroy() {
    this.closed = true
    this.awareness.destroy()
    this.doc.destroy()
  }
}

type AwarenessChange = { added: number[]; updated: number[]; removed: number[] }

function send(ws: WebSocket, msg: Uint8Array) {
  if (ws.readyState === ws.OPEN) ws.send(msg, err => err && ws.terminate())
}

export type RoomsOptions = {
  store: Store
  pubsub?: PubSub // set when running several instances behind a load balancer
  saveIntervalMs: number // how often a changed document is written to Postgres
  versionIntervalMs: number // how often a changed document gets a version-history snapshot
}

// Owns all open rooms. A room is loaded from Postgres when its first user joins,
// saved periodically while it changes, and saved + unloaded when its last user leaves.
export class Rooms {
  private rooms = new Map<string, Promise<Room>>()
  private closing = new Map<string, Promise<void>>() // rooms still writing their final save
  private opts: RoomsOptions

  constructor(opts: RoomsOptions) {
    this.opts = opts
  }

  private get(name: string): Promise<Room> {
    let room = this.rooms.get(name)
    if (!room) {
      room = this.load(name)
      this.rooms.set(name, room)
      room.catch(() => this.rooms.delete(name))
    }
    return room
  }

  private async load(name: string) {
    await this.closing.get(name) // don't read a state that is still being written
    const room = new Room(name)
    const state = await this.opts.store.load(name)
    if (state) Y.applyUpdate(room.doc, state)
    room.saver = new Saver(room, this.opts) // created after loading, so loading itself isn't a "change"
    if (this.opts.pubsub) await linkInstances(room, this.opts.pubsub)
    return room
  }

  async connect(ws: WebSocket, name: string) {
    // Messages can arrive while the room is still loading from Postgres; queue them.
    const queue: Uint8Array[] = []
    let room: Room | undefined
    let gone = false
    ws.on('message', (data: Buffer) => {
      if (!room) return void queue.push(new Uint8Array(data))
      try {
        room.handle(ws, new Uint8Array(data))
      } catch (err) {
        console.error('bad message, closing socket', err)
        ws.close()
      }
    })
    ws.on('close', () => {
      gone = true
      if (room) this.leave(room, ws)
    })

    let r: Room
    try {
      do r = await this.get(name)
      while (r.closed) // it was unloaded while we waited; load it again
    } catch (err) {
      console.error(`failed to load ${name}`, err)
      return ws.close(1011)
    }
    if (gone) return
    room = r
    room.join(ws)
    for (const msg of queue) room.handle(ws, msg)
  }

  private leave(room: Room, ws: WebSocket) {
    room.leave(ws)
    if (room.conns.size > 0) return
    this.rooms.delete(room.name)
    room.closed = true
    const done = Promise.all([room.saver!.stop(), this.opts.pubsub?.unsubscribe(room.name)]).then(() => {}, err => console.error(err)).finally(() => {
      room.destroy()
      this.closing.delete(room.name)
    })
    this.closing.set(room.name, done)
  }

  // Graceful shutdown: save every open room.
  async closeAll() {
    const rooms = await Promise.allSettled(this.rooms.values())
    this.rooms.clear()
    await Promise.all(rooms.map(r => r.status === 'fulfilled' && r.value.saver!.stop()))
    await Promise.all(this.closing.values())
  }
}

const FROM_REDIS = Symbol('from-redis')

// Keeps this instance's copy of a room in sync with the same room on other instances.
// Changes made by our clients go out to Redis; changes from Redis are applied locally
// (and forwarded to our clients by the room's normal update handler) but not re-published.
async function linkInstances(room: Room, pubsub: PubSub) {
  room.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== FROM_REDIS) pubsub.publish(room.name, UPDATE, update)
  })
  room.awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
    if (origin !== FROM_REDIS)
      pubsub.publish(room.name, AWARENESS, awarenessProtocol.encodeAwarenessUpdate(room.awareness, added.concat(updated, removed)))
  })
  await pubsub.subscribe(room.name, (kind, payload) => {
    if (room.closed) return
    if (kind === UPDATE) Y.applyUpdate(room.doc, payload, FROM_REDIS)
    else if (kind === AWARENESS) awarenessProtocol.applyAwarenessUpdate(room.awareness, payload, FROM_REDIS)
    else if (kind === HELLO) {
      // Another instance just opened this doc. Send it whatever it is missing
      // (edits we have not saved to Postgres yet) and who is here right now.
      pubsub.publish(room.name, UPDATE, Y.encodeStateAsUpdate(room.doc, payload))
      const clients = [...room.awareness.getStates().keys()]
      if (clients.length) pubsub.publish(room.name, AWARENESS, awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients))
    }
  })
  // Subscribe first, then say hello, so no reply can be missed.
  pubsub.publish(room.name, HELLO, Y.encodeStateVector(room.doc))
}

// Writes a room to Postgres at most once per saveIntervalMs while it keeps changing,
// and snapshots it into version history at most once per versionIntervalMs.
// ponytail: saves the full state each time (O(document size)); an append-only update
// log would be cheaper for very large documents.
class Saver {
  private room: Room
  private opts: RoomsOptions
  private dirty = false
  private dirtySinceVersion = false
  private timer?: NodeJS.Timeout
  private versionTimer: NodeJS.Timeout
  private saving = Promise.resolve()
  private stopped = false

  constructor(room: Room, opts: RoomsOptions) {
    this.room = room
    this.opts = opts
    room.doc.on('update', () => this.changed())
    this.versionTimer = setInterval(() => this.run(false, true), opts.versionIntervalMs)
  }

  private changed() {
    this.dirty = this.dirtySinceVersion = true
    if (this.stopped) return
    this.timer ??= setTimeout(() => this.run(true, false), this.opts.saveIntervalMs)
  }

  // Saves are chained so two never run at once for the same room.
  private run(save: boolean, version: boolean) {
    if (save) this.timer = undefined
    this.saving = this.saving.then(async () => {
      const doSave = save && this.dirty
      const doVersion = version && this.dirtySinceVersion
      if (!doSave && !doVersion) return
      const state = Y.encodeStateAsUpdate(this.room.doc)
      if (doSave) this.dirty = false
      if (doVersion) this.dirtySinceVersion = false
      try {
        if (doSave) await this.opts.store.save(this.room.name, state)
        if (doVersion) await this.opts.store.addVersion(this.room.name, state, this.opts.versionIntervalMs / 2)
      } catch (err) {
        console.error(`saving ${this.room.name} failed, will retry`, err)
        if (doSave) this.changed()
        if (doVersion) this.dirtySinceVersion = true
      }
    })
    return this.saving
  }

  // Final save + snapshot when the room is unloaded.
  // ponytail: if this last save fails the unsaved edits are only logged, not retried.
  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearInterval(this.versionTimer)
    return this.run(true, true)
  }
}
