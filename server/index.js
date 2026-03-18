/**
 * server/index.js - Express + WebSocket 同步伺服器
 * 用途：接收外部廣播訊息（PGM/PVW）並即時推播給所有已連線的前端客戶端
 * 執行：node server/index.js
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3333

const DIST_DIR = join(__dirname, '../dist')

const app = express()
app.use(cors())
app.use(express.json())

// ── API 路由（優先於靜態檔案）──────────────────────────────────────────────

// 廣播測試頁面
app.get('/test', (req, res) => {
	res.sendFile(join(__dirname, 'broadcast.html'))
})

// HTTP POST 廣播端點（外部系統可用 HTTP 觸發）
app.post('/broadcast', (req, res) => {
	const payload = req.body
	if (!payload || !payload.type) {
		return res.status(400).json({ ok: false, error: '缺少 type 欄位' })
	}
	if (payload.type !== 'clear' && !payload.name) {
		return res.status(400).json({ ok: false, error: '缺少 name 欄位' })
	}
	const msg = JSON.stringify(payload)
	let count = 0
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(msg)
			count++
		}
	}
	console.log(`[HTTP] 廣播 ${msg} → ${count} 個客戶端`)
	res.json({ ok: true, clients: count, payload })
})

// 取得目前連線數
app.get('/status', (req, res) => {
	let count = 0
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) count++
	}
	res.json({ ok: true, clients: count })
})

// ── 靜態檔案 & SPA fallback ────────────────────────────────────────────────

// 服務 Vite build 產出的靜態資源
app.use(express.static(DIST_DIR))

// SPA fallback：其他所有路徑都回 index.html（讓 Vue Router 處理）
app.get('/{*path}', (req, res) => {
	res.sendFile(join(DIST_DIR, 'index.html'))
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
	const ip = req.socket.remoteAddress
	console.log(`[WS] 客戶端連線 ${ip}，目前共 ${wss.clients.size} 個`)

	// 收到訊息後廣播給所有客戶端（含自己）
	ws.on('message', (data) => {
		const raw = data.toString()
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			console.warn('[WS] 收到非 JSON 訊息:', raw)
			return
		}

		if (!parsed.type) {
			console.warn('[WS] 訊息缺少 type:', raw)
			return
		}
		if (parsed.type !== 'clear' && !parsed.name) {
			console.warn('[WS] 訊息缺少 name:', raw)
			return
		}

		const extra = parsed.scene_type ? ` scene_type=${parsed.scene_type}` : ''
		const startedInfo = parsed.started != null ? ` started=${parsed.started}` : ''
		console.log(`[WS] 廣播: type=${parsed.type} name=${parsed.name ?? ''}${extra}${startedInfo}`)
		for (const client of wss.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(raw)
			}
		}
	})

	ws.on('close', () => {
		console.log(`[WS] 客戶端斷線，剩餘 ${wss.clients.size} 個`)
	})

	ws.on('error', (err) => {
		console.error('[WS] 錯誤:', err.message)
	})
})

server.listen(PORT, () => {
	console.log(`伺服器已啟動：http://localhost:${PORT}`)
	console.log(`流程頁：      http://localhost:${PORT}/`)
	console.log(`廣播測試頁：  http://localhost:${PORT}/test`)
	console.log(`WebSocket：   ws://localhost:${PORT}/ws`)
	console.log(`HTTP 廣播：   POST http://localhost:${PORT}/broadcast`)
})
