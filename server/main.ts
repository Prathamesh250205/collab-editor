import { startServer } from './index.ts'

const server = await startServer({
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://collab:collab@localhost:5432/collab',
  redisUrl: process.env.REDIS_URL,
})
console.log(`listening on http://localhost:${server.port}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close()
    process.exit(0)
  })
}
