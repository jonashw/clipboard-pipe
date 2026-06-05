import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import http from 'http'

const HTTP_PORT = 5174
const HTTPS_PORT = 5173

const httpRedirectPlugin = {
  name: 'http-redirect',
  configureServer(server: { httpServer: { on: (event: string, cb: () => void) => void } | null }) {
    const redirectServer = http.createServer((req, res) => {
      const location = `https://localhost:${HTTPS_PORT}${req.url ?? '/'}`
      res.writeHead(301, { Location: location })
      res.end()
    })
    redirectServer.listen(HTTP_PORT, () => {
      console.log(`  ➜  HTTP redirect: http://localhost:${HTTP_PORT} → https://localhost:${HTTPS_PORT}`)
    })
    server.httpServer?.on('close', () => redirectServer.close())
  },
}

export default defineConfig({
  plugins: [react(), httpRedirectPlugin],
  server: {
    port: HTTPS_PORT,
    https: {
      key: fs.readFileSync('./localhost-key.pem'),
      cert: fs.readFileSync('./localhost.pem'),
    },
  },
})
