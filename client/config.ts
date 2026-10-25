// Where the backend lives. Empty = same origin as the page (Docker, local dev).
// When the frontend is on Vercel and the server on Render, set VITE_SERVER_URL
// at build time to the Render URL, e.g. https://collab-editor.onrender.com
export const SERVER_URL = (import.meta.env.VITE_SERVER_URL ?? '').replace(/\/$/, '')
export const WS_URL = `${(SERVER_URL || location.origin).replace(/^http/, 'ws')}/ws`
