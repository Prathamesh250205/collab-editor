// Simple auth with Node's crypto only.
// - Passwords: scrypt (a deliberately slow hash) with a random salt per user.
// - Tokens: "<payload>.<signature>" where signature = HMAC-SHA256(payload, secret).
//   Same idea as a JWT: the server can verify a token without a session table,
//   and nobody without the secret can forge one.
import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export async function checkPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':')
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), 64)
  return timingSafeEqual(actual, Buffer.from(hash, 'hex')) // constant time: no timing leak
}

export function signToken(username: string, secret: string) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

// Returns the username, or null if the token is forged, malformed or expired.
export function verifyToken(token: string, secret: string): string | null {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload, secret))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof u === 'string' && exp > Date.now() ? u : null
  } catch {
    return null
  }
}

function sign(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}
