/**
 * server/index.js - Express + WebSocket 同步伺服器
 * 用途：主動輪詢 vMix API 取得 PGM/PVW/inputs，並即時推播給所有已連線的前端客戶端
 * 執行：node server/index.js
 * 環境變數：
 *   PORT       - 監聽 port（預設 3333）
 *   VMIX_HOST  - 預設 vMix 主機 IP（預設 localhost）
 *   VMIX_PORT  - vMix API port（預設 8088）
 *
 * 多 vMix 支援：
 *   每個 vMix instance 以 id 區分（預設為 'default'）
 *   前端以 ?vmix=<id> 連線 WS，API 路由亦帶 /:id
 *   範例：/?vmix=stage-a  /?vmix=stage-b
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import cors from 'cors'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { XMLParser } from 'fast-xml-parser'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3333
const DIST_DIR = join(__dirname, '../dist')
const VMIX_API_PORT = Number(process.env.VMIX_PORT) || 8088
const ML_API_PORT = Number(process.env.ML_PORT) || 3334

const app = express()
app.use(cors())
app.use(express.json())

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
let mlDurationCache = []

function normalizePathForMatch(path) {
	return String(path ?? '').replaceAll('\\', '/').toLowerCase()
}

function buildMlDurationCacheItems(payload) {
	const results = payload?.results
	if (!results || typeof results !== 'object') return []

	return Object.values(results).flatMap((entry) => {
		if (!entry || !Number.isFinite(entry.durationSeconds)) entry.durationSeconds = 5940 // no data
		const filePath = String(entry.filePath ?? '')
		const normalizedPath = normalizePathForMatch(filePath)
		const filename = filePath.split(/[\\/]/).pop() ?? ''
		const fileStem = filename.replace(/\.[^/.]+$/, '').toLowerCase()

		const patterns = []
		if (normalizedPath) patterns.push(normalizedPath)
		if (fileStem) patterns.push(fileStem)

		if (patterns.length === 0) return []

		return [{
			patterns,
			duration: Number(entry.durationSeconds),
		}]
	})
}

async function refreshMlDurations(mainHost) {
	const targets = [
		{ day: '1', stage: '1' },
		{ day: '1', stage: '2' },
		{ day: '2', stage: '1' },
		{ day: '2', stage: '2' },
	]
	const requests = targets.map(async ({ day, stage }) => {
		const url = `http://${mainHost}:${ML_API_PORT}/media-lounge/durations?day=${day}&stage=${stage}`
		const res = await fetch(url, { signal: AbortSignal.timeout(900) })
		if (!res.ok) throw new Error(`HTTP ${res.status} day=${day} stage=${stage}`)
		const data = await res.json()
		if (!data?.ok) throw new Error(`API ok=false day=${day} stage=${stage}`)
		return data
	})

	const settled = await Promise.allSettled(requests)
	const nextCache = settled
		.filter((item) => item.status === 'fulfilled')
		.flatMap((item) => buildMlDurationCacheItems(item.value))

	// console.log('item.value', item.value)

	if (nextCache.length > 0) {
		mlDurationCache = nextCache
	}
}

function startMlDurationPolling(mainHost) {
	const host = String(mainHost ?? '').trim()
	if (!host) return

	refreshMlDurations(host).catch(() => {})
	setInterval(() => {
		refreshMlDurations(host).catch(() => {})
	}, 1000)
}

// ── Test Mode ──────────────────────────────────────────────────────────────

const TEST_MODE = process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1'

const TEST_XML_PATH = join(__dirname, '../data/api.xml')

/**
 * 讀取 data/api.xml 並解析成 inputs + active + preview，
 * 格式與 fetchVmixState 解析真實 API 的結果一致。
 */
function loadTestDataFromXml() {
	try {
		const xml = readFileSync(TEST_XML_PATH, 'utf-8')
		const parsed = xmlParser.parse(xml)
		const vmix = parsed?.vmix
		if (!vmix) throw new Error('XML 格式錯誤，缺少 <vmix> 根節點')

		const inputsRaw = vmix.inputs?.input
		const inputsArr = Array.isArray(inputsRaw) ? inputsRaw : (inputsRaw ? [inputsRaw] : [])

		const inputs = inputsArr.map((inp) => {
			const input = {
				number: String(inp['@_number'] ?? ''),
				title: String( (inp['@_type'] === 'VideoList' ? (inp['@_shortTitle'] ?? inp['@_title'] ?? '') : (inp['@_title'] ?? inp['@_shortTitle'] ?? '')) ),
				type: String(inp['@_type'] ?? ''),
				position: Number(inp['@_position'] ?? 0),
			}
			if (input.type === 'VideoList') {
				const listRaw = inp.list?.item
				const listArr = Array.isArray(listRaw) ? listRaw : (listRaw ? [listRaw] : [])
				input.items = listArr.map((item) => {
					// XML 中 item 為純文字路徑；selected="true" 的 item 會被解析成物件
					const isObj = typeof item === 'object' && item !== null
					const path = isObj ? String(item['#text'] ?? '') : String(item)
					const filename = path.split(/[\\/]/).pop() ?? ''
					const name = filename.replace(/\.[^/.]+$/, '')
					const selected = isObj
						? String(item['@_selected'] ?? 'False').toLowerCase() === 'true'
						: false
					return { name, duration: getDuration(path), selected }
				})
			}
			return input
		})

		const active = String(vmix.active ?? '')
		const preview = String(vmix.preview ?? '')
		return { inputs, active, preview }
	} catch (err) {
		console.error('[TEST] 無法讀取 api.xml:', err.message)
		return null
	}
}

function getDuration(item) {
	const isObj = typeof item === 'object' && item !== null
	const path = isObj ? String(item['#text'] ?? '') : String(item)
	const normalizedPath = normalizePathForMatch(path)

	// console.log('mlDurationCache', mlDurationCache)

	if (normalizedPath.includes('ml')) {
		for (const item of mlDurationCache) {
			if (item.patterns.some((pattern) => normalizedPath.includes(pattern))) {
				return item.duration
			}
		}
	}

	const durationMapping = [
		// 廣告
		['2026_MegaportCF_30s', 30],
		['尾一_Alcon', 30],

		// 中插
		['中插 1 to 4', 120],
		['中插 5 to 8', 120],

		// 節目表
		['STG1-D1-DAY', 300],
		['STG1-D1-NIGHT', 300],
		['STG1-D2-DAY', 300],
		['STG1-D2-NIGHT', 300],
		['STG2-D1-DAY', 300],
		['STG2-D1-NIGHT', 300],
		['STG2-D2-DAY', 300],
		['STG2-D2-NIGHT', 300],

		// 包框影片
		['包框影片', 180]
	]
	for (const [filename, duration] of durationMapping) {
		if (path.includes(filename)) return duration
	}
	return 0
}

async function startTestMode(inst) {
	if (inst.pollTimer) clearInterval(inst.pollTimer)

	// TEST_MODE 需要先嘗試拉一次 ML duration，避免第一次載入時 duration 都是 0。
	try {
		await refreshMlDurations(inst.host)
	} catch {}

	const testData = loadTestDataFromXml()
	if (!testData) {
		console.error(`[TEST:${inst.id}] 無法載入測試資料，請確認 data/api.xml 存在`)
		return
	}

	inst.connected = true
	inst.inputs = testData.inputs
	broadcastToId(inst.id, { type: 'vmix-status', connected: true })
	broadcastToId(inst.id, { type: 'inputs', inputs: testData.inputs.filter((i) => i.title) })

	const pgmInput = testData.inputs.find((i) => i.number === testData.active)
	const pvwInput = testData.inputs.find((i) => i.number === testData.preview)

	if (pgmInput) {
		inst.lastPgmTitle = pgmInput.title
		const payload = { type: 'pgm', name: pgmInput.title }
		if (pgmInput.type === 'VideoList') {
			payload.scene_type = 'list'
			payload.started = Math.round(pgmInput.position / 1000)
		}
		inst.lastPgmPayload = payload
		broadcastToId(inst.id, payload)
	}

	if (pvwInput) {
		inst.lastPvwTitle = pvwInput.title
		broadcastToId(inst.id, { type: 'pvw', name: pvwInput.title })
	}

	console.log(`[TEST:${inst.id}] 測試模式啟動（data/api.xml）PGM=${inst.lastPgmTitle} / PVW=${inst.lastPvwTitle}`)
}

// ── vMix 多 instance 管理 ──────────────────────────────────────────────────

/**
 * @typedef {{ id: string, host: string, connected: boolean, inputs: Array,
 *   lastPgmTitle: string|null, lastPvwTitle: string|null,
 *   lastInputsJson: string, pollTimer: ReturnType<typeof setInterval>|null }} VmixInstance
 */

/** @type {Map<string, VmixInstance>} */
const vmixInstances = new Map()

function createInstance(id, host) {
	return {
		id,
		host,
		connected: false,
		inputs: [],
		lastPgmTitle: null,
		lastPvwTitle: null,
		lastPgmPayload: null,
		lastInputsJson: '',
		pollTimer: null,
	}
}

function getOrCreateInstance(id, host = 'localhost') {
	if (!vmixInstances.has(id)) {
		vmixInstances.set(id, createInstance(id, host))
	}
	return vmixInstances.get(id)
}

// ── 廣播（只送給訂閱同一 vmixId 的 WS 客戶端）────────────────────────────

function broadcastToId(id, payload) {
	const msg = JSON.stringify(payload)
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN && client.vmixId === id) {
			client.send(msg)
		}
	}
}

// ── vMix 輪詢 ──────────────────────────────────────────────────────────────

async function fetchVmixState(inst) {
	try {
		const res = await fetch(`http://${inst.host}:${VMIX_API_PORT}/api/`, {
			signal: AbortSignal.timeout(2000),
		})
		if (!res.ok) {
			setVmixConnected(inst, false)
			return
		}

		const xml = await res.text()
		const parsed = xmlParser.parse(xml)
		const vmix = parsed?.vmix
		if (!vmix) {
			setVmixConnected(inst, false)
			return
		}

		setVmixConnected(inst, true)

		// 解析 inputs 清單
		const inputsRaw = vmix.inputs?.input
		const inputsArr = Array.isArray(inputsRaw) ? inputsRaw : (inputsRaw ? [inputsRaw] : [])
		const newInputs = inputsArr.map((inp) => {
			const input = {
				number: String(inp['@_number'] ?? ''),
				title: String(inp['@_title'] ?? inp['@_shortTitle'] ?? ''),
				type: String(inp['@_type'] ?? ''),
				position: Number(inp['@_position'] ?? 0),
			}
			// VideoList：解析子項目清單
			if (input.type === 'VideoList') {
				const listRaw = inp.list?.item
				const listArr = Array.isArray(listRaw) ? listRaw : (listRaw ? [listRaw] : [])
				input.items = listArr.map((item) => {
					const filename = String(item['@_filename'] ?? item['@_filenamewithoutext'] ?? '')
					const name = filename ? filename.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '') : ''
					return {
						name,
						duration: getDuration(filename),
						selected: String(item['@_selected'] ?? 'False').toLowerCase() === 'true',
					}
				})
			}
			return input
		})

		// 若 inputs 清單有異動則廣播（排除 position 抖動）
		const newInputsJson = JSON.stringify(newInputs.map((i) => ({
			title: i.title,
			type: i.type,
			items: i.items?.map((item) => ({ name: item.name, duration: item.duration })),
		})))
		if (newInputsJson !== inst.lastInputsJson) {
			inst.lastInputsJson = newInputsJson
			inst.inputs = newInputs
			broadcastToId(inst.id, { type: 'inputs', inputs: newInputs.filter((i) => i.title) })
			console.log(`[vMix:${inst.id}] Inputs 更新：${newInputs.length} 個`)
		} else {
			inst.inputs = newInputs
		}

		// 取得 PGM / PVW
		const activeNum = String(vmix.active ?? '')
		const previewNum = String(vmix.preview ?? '')

		const pgmInput = inst.inputs.find((i) => i.number === activeNum)
		const pvwInput = inst.inputs.find((i) => i.number === previewNum)

		const pgmTitle = pgmInput?.title ?? ''
		const pvwTitle = pvwInput?.title ?? ''

		if (pgmTitle !== inst.lastPgmTitle) {
			inst.lastPgmTitle = pgmTitle
			const payload = { type: 'pgm', name: pgmTitle }
			if (pgmInput && pgmInput.type.toLowerCase().includes('list')) {
				payload.scene_type = 'list'
				payload.started = pgmInput.position / 1000
			}
			inst.lastPgmPayload = payload
			broadcastToId(inst.id, payload)
			console.log(`[vMix:${inst.id}] PGM → ${pgmTitle}`)
		}

		if (pvwTitle !== inst.lastPvwTitle) {
			inst.lastPvwTitle = pvwTitle
			broadcastToId(inst.id, { type: 'pvw', name: pvwTitle })
			console.log(`[vMix:${inst.id}] PVW → ${pvwTitle}`)
		}
	} catch {
		setVmixConnected(inst, false)
	}
}

function setVmixConnected(inst, connected) {
	if (connected === inst.connected) return
	inst.connected = connected
	broadcastToId(inst.id, { type: 'vmix-status', connected })
	if (!connected) {
		console.log(`[vMix:${inst.id}] 無法連線到 ${inst.host}:${VMIX_API_PORT}`)
	} else {
		console.log(`[vMix:${inst.id}] 已連線到 ${inst.host}:${VMIX_API_PORT}`)
	}
}

function startPolling(inst) {
	if (inst.pollTimer) clearInterval(inst.pollTimer)
	fetchVmixState(inst)
	inst.pollTimer = setInterval(() => fetchVmixState(inst), 500)
}

function resetInstance(inst) {
	inst.lastPgmTitle = null
	inst.lastPvwTitle = null
	inst.lastPgmPayload = null
	inst.lastInputsJson = ''
	inst.connected = false
	inst.inputs = []
}

// ── API 路由 ───────────────────────────────────────────────────────────────

// 廣播測試頁面
app.get('/test', (req, res) => {
	res.sendFile(join(__dirname, 'broadcast.html'))
})

// 列出所有 vMix instances
app.get('/vmix-host', (req, res) => {
	const instances = []
	for (const [id, inst] of vmixInstances) {
		instances.push({ id, host: inst.host, port: VMIX_API_PORT, connected: inst.connected })
	}
	res.json({ instances })
})

// 取得指定 id 的 vMix 主機設定與連線狀態
app.get('/vmix-host/:id', (req, res) => {
	const { id } = req.params
	const inst = vmixInstances.get(id)
	if (!inst) return res.status(404).json({ ok: false, error: `instance '${id}' 不存在` })
	res.json({ host: inst.host, port: VMIX_API_PORT, connected: inst.connected })
})

// 新增或更新指定 id 的 vMix 主機設定
app.post('/vmix-host/:id', (req, res) => {
	const { id } = req.params
	const { host } = req.body
	if (!host) return res.status(400).json({ ok: false, error: '缺少 host 欄位' })
	const inst = getOrCreateInstance(id, host.trim())
	inst.host = host.trim()
	resetInstance(inst)
	if (TEST_MODE) {
		startTestMode(inst)
	} else {
		startPolling(inst)
	}
	console.log(`[vMix:${id}] 主機更新為 ${inst.host}${TEST_MODE ? '（TEST MODE）' : ''}`)
	res.json({ ok: true, id, host: inst.host, testMode: TEST_MODE })
})

// 移除指定 id 的 instance（不可刪除 default）
app.delete('/vmix-host/:id', (req, res) => {
	const { id } = req.params
	if (id === 'default') return res.status(400).json({ ok: false, error: '無法刪除 default instance' })
	const inst = vmixInstances.get(id)
	if (!inst) return res.status(404).json({ ok: false, error: `instance '${id}' 不存在` })
	if (inst.pollTimer) clearInterval(inst.pollTimer)
	vmixInstances.delete(id)
	console.log(`[vMix:${id}] instance 已移除`)
	res.json({ ok: true })
})

// 取得指定 id 的 inputs 清單
app.get('/vmix-inputs/:id', (req, res) => {
	const { id } = req.params
	const inst = vmixInstances.get(id)
	if (!inst) return res.status(404).json({ ok: false, error: `instance '${id}' 不存在` })
	res.json({ ok: true, connected: inst.connected, inputs: inst.inputs.filter((i) => i.title) })
})

// HTTP POST 廣播端點（手動測試用）
app.post('/broadcast', (req, res) => {
	const payload = req.body
	if (!payload || !payload.type) {
		return res.status(400).json({ ok: false, error: '缺少 type 欄位' })
	}
	if (payload.type !== 'clear' && !payload.name) {
		return res.status(400).json({ ok: false, error: '缺少 name 欄位' })
	}
	const id = payload.vmixId ?? 'default'
	broadcastToId(id, payload)
	console.log(`[HTTP] 手動廣播(${id}) ${JSON.stringify(payload)}`)
	res.json({ ok: true, payload })
})

// ── Test Mode API ──────────────────────────────────────────────────────────

// 取得測試模式狀態（是否啟用、各 instance 目前 PGM/PVW）
app.get('/test/status', (req, res) => {
	const instances = []
	for (const [id, inst] of vmixInstances) {
		instances.push({
			id,
			testMode: TEST_MODE,
			pgm: inst.lastPgmTitle,
			pvw: inst.lastPvwTitle,
			inputs: inst.inputs.filter((i) => i.title),
		})
	}
	res.json({ ok: true, testMode: TEST_MODE, instances })
})

// 手動設定指定 instance 的 PGM 或 PVW（TEST_MODE 下才有效果，但任何時候都可廣播）
// body: { vmixId: 'main', type: 'pgm'|'pvw', name: 'Input 標題' }
app.post('/test/set', (req, res) => {
	const { vmixId = 'main', type, name } = req.body ?? {}
	if (!type || !['pgm', 'pvw'].includes(type)) {
		return res.status(400).json({ ok: false, error: 'type 須為 pgm 或 pvw' })
	}
	if (!name) return res.status(400).json({ ok: false, error: '缺少 name 欄位' })

	const inst = vmixInstances.get(vmixId)
	if (!inst) return res.status(404).json({ ok: false, error: `instance '${vmixId}' 不存在` })

	if (type === 'pgm') {
		const pgmInput = inst.inputs.find((i) => i.title === name)
		inst.lastPgmTitle = name
		const payload = { type: 'pgm', name }
		if (pgmInput?.type === 'VideoList') {
			payload.scene_type = 'list'
			payload.started = 0
		}
		inst.lastPgmPayload = payload
		broadcastToId(vmixId, payload)
	} else {
		inst.lastPvwTitle = name
		broadcastToId(vmixId, { type: 'pvw', name })
	}
	console.log(`[TEST:${vmixId}] 手動設定 ${type.toUpperCase()} → ${name}`)
	res.json({ ok: true, vmixId, type, name })
})

// 手動推進到下一個 input（PGM+PVW 同時往前一格）
// POST /test/next/:id  （id = 'main' | 'spare'）
app.post('/test/next/:id', (req, res) => {
	const { id } = req.params
	const inst = vmixInstances.get(id)
	if (!inst) return res.status(404).json({ ok: false, error: `instance '${id}' 不存在` })

	const inputs = inst.inputs.filter((i) => i.title)
	const n = inputs.length
	if (n === 0) return res.status(400).json({ ok: false, error: '無可用 inputs' })

	const pgmIdx = inputs.findIndex((i) => i.title === inst.lastPgmTitle)
	const newPgmIdx = ((pgmIdx + 1) % n + n) % n
	const newPvwIdx = ((newPgmIdx + 1) % n + n) % n

	const pgmInput = inputs[newPgmIdx]
	const pvwInput = inputs[newPvwIdx]

	inst.lastPgmTitle = pgmInput.title
	const payload = { type: 'pgm', name: pgmInput.title }
	if (pgmInput.type === 'VideoList') {
		payload.scene_type = 'list'
		payload.started = 0
	}
	inst.lastPgmPayload = payload
	broadcastToId(id, payload)

	inst.lastPvwTitle = pvwInput.title
	broadcastToId(id, { type: 'pvw', name: pvwInput.title })

	console.log(`[TEST:${id}] 手動 Next → PGM=${pgmInput.title} / PVW=${pvwInput.title}`)
	res.json({ ok: true, id, pgm: pgmInput.title, pvw: pvwInput.title })
})

// 取得目前連線數與所有 vMix 狀態
app.get('/status', (req, res) => {
	let count = 0
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) count++
	}
	const instances = []
	for (const [id, inst] of vmixInstances) {
		instances.push({ id, host: inst.host, connected: inst.connected })
	}
	res.json({ ok: true, clients: count, instances })
})

// ── 靜態檔案 & SPA fallback ────────────────────────────────────────────────

app.use(express.static(DIST_DIR))

app.get('/{*path}', (req, res) => {
	res.sendFile(join(DIST_DIR, 'index.html'))
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws/' })

wss.on('connection', (ws, req) => {
	const url = new URL(req.url, 'http://localhost')
	const vmixId = url.searchParams.get('vmix') ?? 'default'
	ws.vmixId = vmixId

	const inst = vmixInstances.get(vmixId)
	const ip = req.socket.remoteAddress

	// 新客戶端連線時，立即推送目前狀態
	if (inst) {
		ws.send(JSON.stringify({ type: 'vmix-status', connected: inst.connected }))
		if (inst.inputs.length > 0) {
			ws.send(JSON.stringify({ type: 'inputs', inputs: inst.inputs.filter((i) => i.title) }))
		}
		if (inst.lastPgmPayload !== null) {
			ws.send(JSON.stringify(inst.lastPgmPayload))
		}
		if (inst.lastPvwTitle !== null) {
			ws.send(JSON.stringify({ type: 'pvw', name: inst.lastPvwTitle }))
		}
	} else {
		// instance 尚未建立，告知未連線
		ws.send(JSON.stringify({ type: 'vmix-status', connected: false }))
	}

	// 保留手動廣播功能（用於測試）
	ws.on('message', (data) => {
		const raw = data.toString()
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			console.warn('[WS] 收到非 JSON 訊息:', raw)
			return
		}
		if (!parsed.type) return
		broadcastToId(vmixId, parsed)
	})

	ws.on('close', () => {
		
	})

	ws.on('error', (err) => {
		console.error('[WS] 錯誤:', err.message)
	})
})

server.listen(PORT, () => {
	console.log(`伺服器已啟動：http://localhost:${PORT}`)
	console.log(`流程頁：      http://localhost:${PORT}/`)
	console.log(`WebSocket：   ws://localhost:${PORT}/ws/?vmix=main|spare`)

	// 啟動 MAIN 與 SPARE 兩個固定 instance
	const mainInst = getOrCreateInstance('main', process.env.VMIX_HOST_MAIN || process.env.VMIX_HOST || 'localhost')
	const spareInst = getOrCreateInstance('spare', process.env.VMIX_HOST_SPARE || 'localhost')
	startMlDurationPolling(mainInst.host)

	if (TEST_MODE) {
		startTestMode(mainInst)
		startTestMode(spareInst)
	} else {
		startPolling(mainInst)
		startPolling(spareInst)
		console.log(`MAIN  vMix：  ${mainInst.host}:${VMIX_API_PORT}（id=main）`)
		console.log(`SPARE vMix：  ${spareInst.host}:${VMIX_API_PORT}（id=spare）`)
	}
})
