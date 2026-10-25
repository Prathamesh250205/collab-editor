// Hero 3D scene: a picture of the real architecture, not decoration.
// Client replicas orbit two server instances; each edit is a packet that flies to
// its server, fans out to that server's other clients, and crosses to the other
// server over the Redis link, exactly like an update does in server/rooms.ts.
import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { USER_COLORS } from './cmTheme.ts'

const CLIENTS = 16
const POOL = 220 // max packets alive at once
const CORES = [new THREE.Vector3(-1.15, 0, 0), new THREE.Vector3(1.15, 0, 0)]

type Route = { curve: THREE.QuadraticBezierCurve3; reverse: boolean }
type Packet = { route: Route | null; t: number; speed: number; color: THREE.Color; hop: 'up' | 'down' | 'cross'; core: number; from: number }

function arc(a: THREE.Vector3, b: THREE.Vector3, lift: number) {
  const mid = a.clone().add(b).multiplyScalar(0.5)
  mid.y += lift
  return new THREE.QuadraticBezierCurve3(a, mid, b)
}

// A soft round sprite so points render as glowing dots instead of squares.
function dotTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

function Network({ animate }: { animate: boolean }) {
  const group = useRef<THREE.Group>(null!)
  const coreMeshes = useRef<THREE.Mesh[]>([])

  const world = useMemo(() => {
    const clients = Array.from({ length: CLIENTS }, (_, i) => {
      const angle = (i / CLIENTS) * Math.PI * 2 + (i % 2) * 0.2
      const r = 2.6 + ((i * 37) % 10) / 12
      const pos = new THREE.Vector3(Math.cos(angle) * r, Math.sin(i * 1.7) * 0.9, Math.sin(angle) * r)
      const core = pos.x < 0 ? 0 : 1
      return { pos, core, color: new THREE.Color(USER_COLORS[i % USER_COLORS.length]), curve: arc(pos, CORES[core], 0.8) }
    })
    const cross = arc(CORES[0], CORES[1], 0.9)

    const lineMat = new THREE.LineBasicMaterial({ color: '#ece8e1', transparent: true, opacity: 0.07 })
    const lines = clients.map(c => new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.curve.getPoints(40)), lineMat))
    const redis = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(cross.getPoints(40)),
      new THREE.LineBasicMaterial({ color: '#ff6b4a', transparent: true, opacity: 0.35 }),
    )

    const sprite = dotTexture()
    const positions = new Float32Array(POOL * 3).fill(999)
    const colors = new Float32Array(POOL * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.13, map: sprite, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    )

    // Faint dust far behind, for depth.
    const dust = new Float32Array(600 * 3).map((_, i) => (i % 3 === 1 ? (Math.random() - 0.5) * 8 : (Math.random() - 0.5) * 22))
    const dustGeo = new THREE.BufferGeometry()
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dust, 3))
    const dustPoints = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.04, map: sprite, color: '#ece8e1', transparent: true, opacity: 0.35, depthWrite: false }))

    const packets: Packet[] = Array.from({ length: POOL }, () => ({ route: null, t: 0, speed: 0, color: new THREE.Color(), hop: 'up', core: 0, from: 0 }))
    return { clients, cross, lines, redis, points, dustPoints, packets }
  }, [])

  function spawn(route: Route, color: THREE.Color, hop: Packet['hop'], core: number, from: number) {
    const p = world.packets.find(p => !p.route)
    if (!p) return
    Object.assign(p, { route, t: 0, speed: 0.45 + Math.random() * 0.35, hop, core, from })
    p.color.copy(color)
  }

  // When a packet reaches a server: fan out to that server's other clients, and cross to the other server.
  function arrive(p: Packet) {
    if (p.hop === 'down') return
    const local = world.clients.filter((c, i) => c.core === p.core && i !== p.from)
    for (const c of local.sort(() => Math.random() - 0.5).slice(0, 2)) spawn({ curve: c.curve, reverse: true }, p.color, 'down', p.core, p.from)
    if (p.hop === 'up') spawn({ curve: world.cross, reverse: p.core === 1 }, p.color, 'cross', 1 - p.core, p.from)
  }

  useFrame((state, dt) => {
    if (!animate) return
    const d = Math.min(dt, 0.05)
    const g = group.current
    g.rotation.y += d * 0.06
    g.rotation.x += (state.pointer.y * 0.18 - g.rotation.x) * 0.04
    g.rotation.z += (-state.pointer.x * 0.08 - g.rotation.z) * 0.04
    coreMeshes.current.forEach((m, i) => (m.rotation.y += d * (i ? -0.4 : 0.4)))

    if (Math.random() < d * 5) {
      const i = Math.floor(Math.random() * CLIENTS)
      const c = world.clients[i]
      spawn({ curve: c.curve, reverse: false }, c.color, 'up', c.core, i)
    }

    const pos = world.points.geometry.attributes.position as THREE.BufferAttribute
    const col = world.points.geometry.attributes.color as THREE.BufferAttribute
    const v = new THREE.Vector3()
    world.packets.forEach((p, i) => {
      if (!p.route) return pos.setXYZ(i, 999, 999, 999)
      p.t += d * p.speed
      if (p.t >= 1) {
        const done = p
        p.route = null
        arrive(done)
        return pos.setXYZ(i, 999, 999, 999)
      }
      p.route.curve.getPoint(p.route.reverse ? 1 - p.t : p.t, v)
      pos.setXYZ(i, v.x, v.y, v.z)
      col.setXYZ(i, p.color.r, p.color.g, p.color.b)
    })
    pos.needsUpdate = true
    col.needsUpdate = true
  })

  return (
    <group ref={group} rotation={[0.25, 0, 0]}>
      <primitive object={world.dustPoints} />
      {world.lines.map((l, i) => <primitive key={i} object={l} />)}
      <primitive object={world.redis} />
      <primitive object={world.points} />
      {world.clients.map((c, i) => (
        <mesh key={i} position={c.pos}>
          <sphereGeometry args={[0.045, 16, 16]} />
          <meshBasicMaterial color={c.color} />
        </mesh>
      ))}
      {CORES.map((p, i) => (
        <group key={i} position={p}>
          <mesh ref={m => { if (m) coreMeshes.current[i] = m }}>
            <icosahedronGeometry args={[0.42, 1]} />
            <meshBasicMaterial color="#ece8e1" wireframe transparent opacity={0.35} />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.12, 24, 24]} />
            <meshBasicMaterial color={i ? '#4fd1ff' : '#ff6b4a'} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

export default function Scene({ animate }: { animate: boolean }) {
  return (
    <Canvas
      camera={{ position: [0, 1.2, 8.4], fov: 42 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      frameloop={animate ? 'always' : 'demand'}
      aria-hidden
    >
      <Network animate={animate} />
    </Canvas>
  )
}
