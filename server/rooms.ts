// A "room" is one shared document plus everyone connected to it.
// The server keeps its own copy of the Yjs document, so a new client can get
// the full state from the server instead of waiting for another client.
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { WebSocket } from 'ws'

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

export class Rooms {
  private rooms = new Map<string, Room>()

  get(name: string): Room {
    let room = this.rooms.get(name)
    if (!room) this.rooms.set(name, (room = new Room(name)))
    return room
  }

  connect(ws: WebSocket, name: string) {
    const room = this.get(name)
    room.join(ws)
    ws.on('message', (data: Buffer) => {
      try {
        room.handle(ws, new Uint8Array(data))
      } catch (err) {
        console.error('bad message, closing socket', err)
        ws.close()
      }
    })
    ws.on('close', () => {
      room.leave(ws)
      if (room.conns.size === 0) {
        this.rooms.delete(name)
        room.destroy()
      }
    })
  }
}
