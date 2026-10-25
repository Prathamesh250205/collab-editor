import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { motion, useInView, useReducedMotion, useScroll, useTransform, animate } from 'motion/react'
import { Demo } from './Demo.tsx'
import { Logo } from './Logo.tsx'

const Scene = lazy(() => import('./Scene.tsx')) // three.js only loads on the landing page

const REPO = 'https://github.com/Prathamesh250205/collab-editor'

// Measured numbers from loadtest/RESULTS.md and the test suite; nothing here is made up.
const STATS = [
  { value: 500, suffix: '', label: 'concurrent editors', note: '100% of edits delivered' },
  { value: 56, prefix: '≤', suffix: ' ms', label: 'p99 sync latency', note: 'at 250 editors, keystroke to screen' },
  { value: 10000, suffix: '', label: 'randomized concurrent edits', note: 'dropped, duplicated, reordered: zero divergence' },
  { value: 17, suffix: '', label: 'tests in CI', note: 'incl. 3-instance Redis tests' },
]

const STEPS = [
  { k: '01', title: 'Type locally', body: 'Every keystroke lands in your own Yjs replica first. Typing never waits for the network.' },
  { k: '02', title: 'Ship a tiny update', body: 'Yjs encodes the change as a few bytes. A WebSocket carries it to whichever server you are on.' },
  { k: '03', title: 'Fan out, across servers', body: 'The server forwards it to its clients and publishes it on Redis, so other instances deliver it too.' },
  { k: '04', title: 'Converge, always', body: 'A CRDT merges updates in any order. Offline edits replay on reconnect; Postgres keeps the merged state.' },
]

export function Landing({ onStart, username }: { onStart: () => void; username?: string }) {
  const reduced = useReducedMotion() ?? false
  const heroRef = useRef<HTMLElement>(null)
  const heroVisible = useInView(heroRef, { margin: '-20% 0px' })
  const demoRef = useRef<HTMLDivElement>(null)
  const demoVisible = useInView(demoRef, { once: true, margin: '-15% 0px' })
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] })
  const sceneY = useTransform(scrollYProgress, [0, 1], [0, 160])
  const sceneOpacity = useTransform(scrollYProgress, [0, 0.9], [1, 0])

  // Spotlight that follows the pointer across the hero.
  const [spot, setSpot] = useState({ x: 70, y: 40 })

  return (
    <div className="landing">
      <div className="grain" aria-hidden />
      <nav className="nav">
        <a href="/" className="brand" aria-label="Collab Editor home">
          <Logo /> <span>collab</span>
        </a>
        <div className="nav-links">
          <a href="#demo">Live demo</a>
          <a href="#how">How it works</a>
          <a href="#numbers">Numbers</a>
          <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <button className="btn btn-ghost" onClick={onStart}>{username ? 'New document' : 'Sign in'}</button>
      </nav>

      <header
        ref={heroRef}
        className="hero"
        onPointerMove={e => {
          const r = e.currentTarget.getBoundingClientRect()
          setSpot({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 })
        }}
        style={{ '--spot-x': `${spot.x}%`, '--spot-y': `${spot.y}%` } as React.CSSProperties}
      >
        <motion.div className="hero-scene" style={reduced ? undefined : { y: sceneY, opacity: sceneOpacity }}>
          <Suspense fallback={null}>
            <Scene animate={heroVisible && !reduced} />
          </Suspense>
        </motion.div>
        <div className="hero-copy">
          <motion.p className="eyebrow mono" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
            <span className="live-dot" /> CRDT · WebSockets · Redis · Postgres
          </motion.p>
          <h1>
            <Words text="Write code together." />
            <br />
            <em><Words text="Merge without conflict." delay={0.35} /></em>
          </h1>
          <motion.p className="lede" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8, duration: 0.6 }}>
            A real-time collaborative code editor. Share a link, see live cursors, keep typing offline.
            Every replica converges, across any number of servers.
          </motion.p>
          <motion.div className="hero-cta" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1, duration: 0.6 }}>
            <button className="btn btn-primary" onClick={onStart}>
              Start a document <span aria-hidden>→</span>
            </button>
            <a className="btn btn-ghost" href={REPO} target="_blank" rel="noreferrer">
              View source
            </a>
          </motion.div>
          <motion.ul className="hero-legend mono" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.3 }}>
            <li><span className="swatch" style={{ background: '#ff6b4a' }} /> client replicas</li>
            <li><span className="swatch ring" /> server instances</li>
            <li><span className="swatch" style={{ background: '#ff6b4a', height: 2 }} /> Redis link</li>
          </motion.ul>
        </div>
      </header>

      <Section id="demo" kicker="Live demo" title={<>Two replicas. <em>One truth.</em></>}>
        <p className="section-lede">
          This is real Yjs running in your browser, joined by a simulated network. Take a replica offline,
          type in both, crank the latency up, then reconnect.
        </p>
        <div ref={demoRef}>
          <Demo active={demoVisible} />
        </div>
      </Section>

      <Section id="how" kicker="How it works" title={<>From keystroke to <em>every screen.</em></>}>
        <div className="steps">
          {STEPS.map((s, i) => (
            <motion.article
              key={s.k}
              className="step"
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-10% 0px' }}
              transition={{ delay: i * 0.08, duration: 0.5 }}
            >
              <span className="mono step-k">{s.k}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </motion.article>
          ))}
        </div>
        <FlowDiagram />
      </Section>

      <Section id="numbers" kicker="Measured, not claimed" title={<>Numbers from <em>the load test.</em></>}>
        <div className="stats">
          {STATS.map((s, i) => (
            <motion.div
              key={s.label}
              className="stat"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
            >
              <div className="stat-value">
                {s.prefix}
                <CountUp to={s.value} />
                {s.suffix}
              </div>
              <div className="stat-label">{s.label}</div>
              <div className="stat-note mono">{s.note}</div>
            </motion.div>
          ))}
        </div>
        <p className="fine muted">
          Measured on a 2-core laptop running server, Postgres, Redis and the load generator together.
          Full method and raw tables in <a href={`${REPO}/blob/main/loadtest/RESULTS.md`} target="_blank" rel="noreferrer">loadtest/RESULTS.md</a>.
        </p>
      </Section>

      <section className="closing">
        <motion.h2 initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          Open a document. <em>Send the link.</em>
        </motion.h2>
        <button className="btn btn-primary btn-lg" onClick={onStart}>
          Start a document <span aria-hidden>→</span>
        </button>
      </section>

      <footer className="footer mono">
        <span>React · CodeMirror 6 · Yjs · Node.js · PostgreSQL · Redis</span>
        <a href={REPO} target="_blank" rel="noreferrer">github.com/Prathamesh250205/collab-editor</a>
      </footer>
    </div>
  )
}

function Section({ id, kicker, title, children }: { id: string; kicker: string; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="section">
      <motion.div className="section-head" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-10% 0px' }} transition={{ duration: 0.6 }}>
        <p className="kicker mono">{kicker}</p>
        <h2>{title}</h2>
      </motion.div>
      {children}
    </section>
  )
}

// Headline words rise in one after another.
function Words({ text, delay = 0 }: { text: string; delay?: number }) {
  return (
    <>
      {text.split(' ').map((w, i, all) => (
        <span key={i}>
          <span className="word-mask">
            <motion.span
              className="word"
              // --wi spreads one gradient across the words (used by the italic line)
              style={{ '--wi': all.length > 1 ? i / (all.length - 1) : 0 } as React.CSSProperties}
              initial={{ y: '110%', filter: 'blur(6px)' }}
              animate={{ y: 0, filter: 'blur(0px)' }}
              transition={{ delay: delay + i * 0.07, duration: 0.7, ease: [0.2, 0.7, 0.1, 1] }}
            >
              {w}
            </motion.span>
          </span>{' '}
        </span>
      ))}
    </>
  )
}

function CountUp({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true })
  useEffect(() => {
    if (!inView || !ref.current) return
    const node = ref.current
    const controls = animate(0, to, { duration: 1.4, ease: [0.2, 0.7, 0.1, 1], onUpdate: v => (node.textContent = Math.round(v).toLocaleString('en-US')) })
    return () => controls.stop()
  }, [inView, to])
  return <span ref={ref}>0</span>
}

// The architecture as a small animated diagram: dashes flow along each link.
function FlowDiagram() {
  const box = (x: number, y: number, w: number, label: string, sub: string, accent?: string) => (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height="56" rx="10" className="fd-box" style={accent ? { stroke: accent } : undefined} />
      <text x={w / 2} y="25" className="fd-label">{label}</text>
      <text x={w / 2} y="42" className="fd-sub">{sub}</text>
    </g>
  )
  return (
    <motion.svg className="flow" viewBox="0 0 860 250" role="img" aria-label="Architecture: browsers connect over WebSockets to two server instances linked by Redis, which save to PostgreSQL" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}>
      <path d="M150 56 H300" className="fd-link" />
      <path d="M150 194 H300" className="fd-link" />
      <path d="M560 56 H710" className="fd-link" />
      <path d="M430 84 V166" className="fd-link fd-redis" />
      <path d="M560 194 H710" className="fd-link fd-db" />
      <path d="M540 84 C 620 110, 660 150, 735 166" className="fd-link fd-db" />
      {box(10, 28, 140, 'Browser', 'Y.Doc + IndexedDB', '#ff6b4a')}
      {box(10, 166, 140, 'Browser', 'Y.Doc + IndexedDB', '#4fd1ff')}
      {box(300, 28, 260, 'Instance 1', 'room = Y.Doc + awareness')}
      {box(300, 166, 260, 'Instance 2', 'room = Y.Doc + awareness')}
      {box(710, 28, 140, 'Browser', 'Y.Doc + IndexedDB', '#9be15d')}
      {box(710, 166, 140, 'PostgreSQL', 'merge-on-save', '#4fd1ff')}
      <text x="442" y="130" className="fd-tag" textAnchor="start">Redis pub/sub</text>
      <text x="635" y="186" className="fd-tag">snapshots</text>
      <text x="225" y="48" className="fd-tag">WebSocket</text>
    </motion.svg>
  )
}
