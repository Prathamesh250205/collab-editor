# Collab Editor

A real-time collaborative code editor, like Google Docs for code. Several people open the same document link, edit at the same time, and see each other's live cursors. Edits made offline merge automatically when the connection comes back.

**Stack:** React + TypeScript, CodeMirror 6, Yjs (CRDT), Node.js WebSocket server, PostgreSQL, Redis pub/sub, Docker Compose, GitHub Actions.

## Features

- **Real-time co-editing** with conflict-free merging (Yjs CRDT). Typing never waits for the network.
- **Live cursors and presence:** see who is in the document and where they are typing.
- **Shareable links:** `/d/<docId>` is the document; send the URL to collaborate.
- **Persistence:** documents are saved to PostgreSQL. A version snapshot is taken every minute while a document changes. You can browse history and restore any version.
- **Offline editing:** edits are kept in the browser (IndexedDB) and merge with everyone else's on reconnect.
- **Horizontal scaling:** run any number of server instances. They stay in sync through Redis pub/sub, with periodic anti-entropy to repair lost messages.
- **Auth:** username/password accounts (scrypt-hashed). HMAC-signed tokens are required for the WebSocket and the API.

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser (each user)"]
    CM[CodeMirror 6] <--> YD[Y.Doc replica]
    YD <--> IDB[(IndexedDB<br/>offline copy)]
  end
  YD <-- "WebSocket<br/>y-websocket protocol<br/>(sync + awareness)" --> S1
  YD2[Other users] <-- WebSocket --> S2
  subgraph Servers["Server instances (Node.js)"]
    S1[Instance 1<br/>room = Y.Doc + awareness]
    S2[Instance 2<br/>room = Y.Doc + awareness]
  end
  S1 <-- "pub/sub channel doc:&lt;id&gt;<br/>updates, cursors, HELLO" --> R[(Redis)]
  S2 <--> R
  S1 -- "merge-on-save every 2s<br/>snapshot every 60s" --> PG[(PostgreSQL<br/>documents, versions, users)]
  S2 --> PG
```

### How an edit travels

1. You type. CodeMirror changes the local **Y.Doc** right away; no round-trip.
2. Yjs produces a small binary **update**. The WebSocket provider sends it to the server.
3. The server applies it to its own copy of the document (a **room**). It forwards the update to every other client in the room and publishes it to Redis channel `doc:<id>`.
4. Other instances receive it from Redis, apply it to their copy and forward it to their clients.
5. Every replica applies the same set of updates. Because it is a CRDT, they all end up identical regardless of order.

### Joining, reconnecting and offline edits: one mechanism

When a socket connects, the server and client run a **two-way sync handshake**:
- Each side sends its *state vector*: "for every client id, how many operations I have".
- The other side replies with exactly the operations missing.

A brand-new client, a client back from an hour offline, and a server instance that missed a Redis message all use the same rule: "tell me what you have, and I'll send what you're missing".

## Measured results

Measured on a 2-core laptop (i5-6300U). Server, Postgres, Redis and the load generator all run on the same machine. Ten editors per document each type an edit every ~500 ms. Latency is measured end to end, from the keystroke on one client to the edit appearing on another client, through the server. Full tables are in [loadtest/RESULTS.md](loadtest/RESULTS.md).

| concurrent editors | edits/s | delivered | p50 | p99 |
|---:|---:|---:|---:|---:|
| 100 | ~200 | 100% | 2.3 ms | 8.2 ms |
| 250 | ~495 | 100% | 3.1–3.3 ms | **15–56 ms** (4 runs) |
| 500 | ~970 | 100% | 8.3–9.1 ms | **135–295 ms** (4 runs) |
| 500, across 2 instances via Redis | ~920 | 100% | 29.7 ms | 358 ms |

Above ~500 editors, latency climbs into seconds. CPU measurements show why: at 750 editors the **server process used under half of one core**, while the load generator used ~2.3 cores of the laptop's 2 physical cores. The ceiling in this table is therefore the test machine, and the server's own limit is higher but **not measured**.

**Tests:** 16 tests, all passing:
- A randomized convergence test: 5 seeds × 4,000 steps, about 10,000 concurrent edits across 5 replicas. The "network" drops, duplicates and reorders messages while replicas go offline. Every replica ends identical.
- End-to-end tests against the real server and Postgres: sync, late join, restart persistence, offline merge on both sides, presence cleanup, randomized multi-client convergence, auth.
- Multi-instance tests with 3 servers on one Redis, including a lost-message repair test.

## Design decisions

**CRDT (Yjs) instead of Operational Transformation.**
- OT needs a central server to transform every pair of concurrent operations, and it gets complicated with offline edits.
- A CRDT gives every character a unique id and ordering, so any two replicas can merge in any order and still match. That's what makes offline editing and multiple servers simple.
- The cost is metadata (ids and deletion tombstones), which Yjs keeps small.

**Eventual consistency, on purpose.** My other project, [raftkv](https://github.com/Prathamesh250205/raftkv), is the opposite trade-off: a Raft key-value store where every write waits for a majority, so reads are linearizable.
- For a text editor, waiting for consensus on every keystroke would make typing lag and stop working offline.
- A CRDT accepts writes locally and *converges* later. That's the right choice when availability and latency matter more than every replica agreeing at every instant.

**The server keeps its own copy of each open document.** New users load the document from the server instead of needing another user online. The server is also the natural place to save it.

**Merge-on-save in Postgres.**
- Two instances can save the same document. Instead of last-write-wins, the save locks the row (`SELECT … FOR UPDATE`) and merges the stored CRDT state with the new one (`Y.mergeUpdates`).
- Merging is idempotent and commutative, so concurrent saves can never lose an edit.

**Redis pub/sub between instances, plus anti-entropy.**
- Any client can connect to any instance, so there are no sticky sessions.
- Pub/sub is fire-and-forget, so a newly opened room sends `HELLO` with its state vector and the others reply with what it lacks. This covers edits not yet saved to Postgres.
- The same `HELLO` repeats every 10 s, so a message lost during a Redis blip heals by itself. There's a test that drops messages to prove it.

**Awareness (cursors, names) is separate from the document.** It's ephemeral state that's never saved. It times out after 30 s without a heartbeat, and the server pings sockets so dead connections disappear.

**Simple on purpose.**
- Node 24 runs the TypeScript server directly, so there's no build step for it.
- There's no router library (two routes) and no auth library (scrypt + HMAC from `node:crypto`).

## Run it

**With Docker** (two app instances, Postgres, Redis):

```bash
docker compose up --build
```

Then open http://localhost:3000 and http://localhost:3001 in two browsers, create an account in each, and open the same `/d/<id>` link on both ports. Edits sync across the two instances through Redis.

**Without Docker** (e.g. Windows with PostgreSQL and Memurai/Redis installed):

```bash
psql -U postgres -f db-setup.sql
npm install
npm run build
npm start
```

`db-setup.sql` creates a dev-only `collab` role and database. Defaults: `DATABASE_URL=postgres://collab:collab@localhost:5432/collab`, no Redis (single instance). Set `REDIS_URL=redis://localhost:6379` and a different `PORT` to run more instances. Set `AUTH_SECRET` in production.

For development with hot reload, run `npm run dev:server` and `npm run dev:client`, then open http://localhost:5173.

**Tests and load test** (need Postgres and Redis running):

```bash
npm test
npm run loadtest -- --levels 100,250,500 --seconds 20
```

## Project layout

```
server/
  index.ts    HTTP API, WebSocket upgrade + auth check, heartbeat
  rooms.ts    rooms: sync protocol, presence, load/save, Redis linking, anti-entropy
  store.ts    PostgreSQL: documents, versions, users
  pubsub.ts   Redis pub/sub between instances
  auth.ts     scrypt password hashing, HMAC tokens
client/
  main.tsx    login, home, routing
  Editor.tsx  CodeMirror + Yjs binding, presence, offline (IndexedDB), history panel
test/         convergence, server end-to-end, multi-instance tests
loadtest/     load generator + measured results
```

## Limitations (honest)

- **Access control is "anyone with the link"**: any logged-in user who knows a document id can open and edit it. There are no per-document permissions.
- **Presence names come from the client.** The server checks the token on connect but does not verify the name a client puts in its cursor label.
- The token travels in the WebSocket URL query string, because browsers can't set WebSocket headers. It could appear in proxy logs. There's no login rate limiting.
- **Saves write the full document state** every 2 s while it changes: O(document size). That's fine for source files, but very large documents would want an append-only update log with compaction.
- If the final save when a room closes fails (e.g. Postgres down), the error is logged but not retried. Edits still in other clients' browsers come back when they reconnect, but the server copy is lost.
- Version history stores full snapshots. There's no diff view and no retention policy.
- The load numbers come from one 2-core laptop running everything, so the server's real ceiling and true multi-machine scaling are **not measured**.
- Docker Compose and the image are verified in CI only (Docker isn't available on the development machine).
- Only JavaScript/TypeScript syntax highlighting is configured.
