import { startServer } from './index.ts'

const authSecret = process.env.AUTH_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : 'dev-only-secret')
if (!authSecret) throw new Error('AUTH_SECRET must be set in production')

const server = await startServer({
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://collab:collab@localhost:5432/collab',
  redisUrl: process.env.REDIS_URL,
  authSecret,
})
console.log(`listening on http://localhost:${server.port}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close()
    process.exit(0)
  })
}
