// PostgreSQL persistence. We store the whole Yjs document state as one binary blob
// (bytea) per document, plus periodic snapshots of it as version history.
import pg from 'pg'
import * as Y from 'yjs'

export class Store {
  readonly pool: pg.Pool

  private constructor(pool: pg.Pool) {
    this.pool = pool
  }

  static async connect(url: string) {
    const store = new Store(new pg.Pool({ connectionString: url }))
    // Instances starting at the same time would race on "create table if not exists",
    // so they take turns using a Postgres advisory lock (held on one connection).
    const client = await store.pool.connect()
    try {
      await client.query('select pg_advisory_lock(7262)')
      await client.query(`
        create table if not exists documents (
          id text primary key,
          state bytea not null,
          updated_at timestamptz not null default now()
        );
        create table if not exists versions (
          id bigserial primary key,
          doc_id text not null,
          state bytea not null,
          created_at timestamptz not null default now()
        );
        create index if not exists versions_doc_idx on versions (doc_id, id desc);
        create table if not exists users (
          username text primary key,
          password_hash text not null,
          created_at timestamptz not null default now()
        );
      `)
    } finally {
      await client.query('select pg_advisory_unlock(7262)').catch(() => {})
      client.release()
    }
    return store
  }

  async load(docId: string): Promise<Uint8Array | null> {
    const { rows } = await this.pool.query('select state from documents where id = $1', [docId])
    return rows[0]?.state ?? null
  }

  // Several server instances may save the same document. Instead of "last write wins"
  // (which could drop the other instance's edits), we merge: the saved state is itself
  // a CRDT update, and merging two updates never loses anything. The row lock
  // (FOR UPDATE) makes concurrent saves take turns.
  async save(docId: string, state: Uint8Array) {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('insert into documents (id, state) values ($1, $2) on conflict do nothing', [docId, state])
      const { rows } = await client.query('select state from documents where id = $1 for update', [docId])
      const merged = Y.mergeUpdates([rows[0].state, state])
      await client.query('update documents set state = $2, updated_at = now() where id = $1', [docId, merged])
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  }

  // Skips the snapshot if this document already got one in the last `minGapMs`
  // (e.g. another instance just took one).
  async addVersion(docId: string, state: Uint8Array, minGapMs: number) {
    await this.pool.query(
      `insert into versions (doc_id, state)
       select $1, $2 where not exists (
         select 1 from versions where doc_id = $1 and created_at > now() - make_interval(secs => $3)
       )`,
      [docId, state, minGapMs / 1000],
    )
  }

  async listVersions(docId: string) {
    const { rows } = await this.pool.query(
      'select id, created_at, length(state) as bytes from versions where doc_id = $1 order by id desc limit 100',
      [docId],
    )
    return rows.map(r => ({ id: Number(r.id), createdAt: r.created_at, bytes: r.bytes }))
  }

  async versionText(docId: string, versionId: number): Promise<string | null> {
    const { rows } = await this.pool.query('select state from versions where doc_id = $1 and id = $2', [docId, versionId])
    if (!rows[0]) return null
    const doc = new Y.Doc()
    Y.applyUpdate(doc, rows[0].state)
    return doc.getText('code').toString()
  }

  // Returns false if the username is taken (the primary key decides, so two
  // simultaneous registrations can't both win).
  async createUser(username: string, passwordHash: string) {
    const { rowCount } = await this.pool.query(
      'insert into users (username, password_hash) values ($1, $2) on conflict do nothing',
      [username, passwordHash],
    )
    return rowCount === 1
  }

  async passwordHash(username: string): Promise<string | null> {
    const { rows } = await this.pool.query('select password_hash from users where username = $1', [username])
    return rows[0]?.password_hash ?? null
  }

  close() {
    return this.pool.end()
  }
}
