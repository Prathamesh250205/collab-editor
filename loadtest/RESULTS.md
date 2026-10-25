# Load test results

Measured on 2026-10-26 with `loadtest/run.ts`.

**Setup**
- Machine: laptop, Intel Core i5-6300U (2 cores / 4 threads, 2.4 GHz), 16 GB RAM, Windows 11, Node 24.
- Server, PostgreSQL 18, Redis (Memurai) and the load generator all run on this one machine.
- Workload: 10 editors per document. Each editor inserts a short tagged string at a random position every ~500 ms (2 edits/s, jittered).
- Each level runs for 20 s.
- **Latency** = time from an edit on one client until it shows up in another client's document (WebSocket → server → WebSocket). It's measured for every receiver of every edit.
- **Delivered** = received / expected (edits × 9 other editors), counted within 2 s after sending stops.

## Single instance

| editors | docs | edits/s | delivered | p50 ms | p95 ms | p99 ms | max ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 10 | 197 | 100% | 2.3 | 5.9 | 8.2 | 16.7 |
| 250 | 25 | 495 | 100% | 3.3 | 11.3 | 55.9 | 225.9 |
| 500 | 50 | 971 | 100% | 9.1 | 90.6 | 135.0 | 222.3 |
| 750 | 75 | 1314 | 100% | 69.2 | 780.7 | 1218.2 | 1550.5 |
| 1000 | 100 | 1630 | 100% | 168.7 | 1396.6 | 1857.7 | 2305.1 |
| 1500 | 150 | 2029 | 98.0% | 1487.4 | 3701.8 | 4725.1 | 5749.5 |

Repeat runs (same command, separate processes):
- 250 editors, p99: 28.7, 31.8, 14.6 ms. Together with the 55.9 above, the range is **15–56 ms**, with 100% delivered every time.
- 500 editors, p99: 294.6, 185.3, 142.6 ms. Together with the 135.0 above, the range is **135–295 ms**, with 100% delivered every time.

## Two instances behind Redis pub/sub

Editors alternate between the two instances, so every document has editors on both. Every edit therefore crosses Redis.

| editors | docs | edits/s | delivered | p50 ms | p95 ms | p99 ms | max ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 10 | 199 | 100% | 2.7 | 7.2 | 12.8 | 36.3 |
| 250 | 25 | 494 | 100% | 4.2 | 18.4 | 40.9 | 94.2 |
| 500 | 50 | 923 | 100% | 29.7 | 237.9 | 357.7 | 494.2 |

## What limits these numbers (measured, not guessed)

- At 500 editors with a single-threaded generator, the server process used **22%** of one core and the generator **78%**. So the generator now runs in worker threads.
- At 750 editors with 3 generator threads, the server process used **47% of one core** and the generator **~2.3 cores**. On this 2-core / 4-thread laptop, the latency growth above ~500 editors comes from the machine being saturated, mostly by the load generator, not from the server running out of CPU.
- The server's own ceiling is therefore higher than this table shows, but it is **not measured**: that needs the generator on a separate machine.
- The 2-instance run shares the same saturated laptop, so it shows that Redis fan-out works under load, not that it scales. A real scaling measurement needs separate machines.

Reproduce:

```
npm start                                   # or two instances: PORT=3001 REDIS_URL=redis://localhost:6379 npm start, etc.
npm run loadtest -- --levels 100,250,500 --seconds 20
npm run loadtest -- --url ws://localhost:3001/ws,ws://localhost:3002/ws --levels 100,250,500
```
