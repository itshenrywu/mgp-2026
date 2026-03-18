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
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { XMLParser } from 'fast-xml-parser'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3333
const DIST_DIR = join(__dirname, '../dist')
const VMIX_API_PORT = Number(process.env.VMIX_PORT) || 8088

const app = express()
app.use(cors())
app.use(express.json())

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

// ── Test Mode ──────────────────────────────────────────────────────────────

const TEST_MODE = process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1'

/**
 * 南霸天 2026-03-21 節目表
 * startSec / endSec = 距午夜的秒數，用於對照現在時刻自動推算 PGM
 */
function makeTestItems(count, totalDuration) {
	const duration = Math.floor(totalDuration / count)
	return Array.from({ length: count }, (_, i) => ({ name: `List Item ${i + 1}`, duration }))
}

const TEST_LIST_ITEMS = {
	'[List] List 1 (ML1)': makeTestItems(5, 54000 - 47400), // 3450s → 690s/item
	'[List] List 2 (ML2)': makeTestItems(5, 56850 - 53400), // 3450s → 690s/item
	'[List] List 3 (ML3)': makeTestItems(5, 62850 - 59400), // 3450s → 690s/item
	'[List] List 4 (ML4)': makeTestItems(5, 68850 - 65400), // 3450s → 690s/item
	'[List] List 5 (ML5)': makeTestItems(5, 75930 - 71400), // 4530s → 906s/item
}

const TEST_SCENES = [
	{ title: '測試',                           type: 'Virtual',   number: '1',  startSec: 0,     endSec: 41400 },
	{ title: '開播前字卡',                      type: 'Virtual',   number: '2',  startSec: 44400, endSec: 44700 },
	{ title: 'Kate 包框 180s_早',              type: 'Virtual',   number: '3',  startSec: 44700, endSec: 44880 },
	{ title: '[Next On] 椅子樂團',             type: 'Virtual',   number: '4',  startSec: 44880, endSec: 45000 },
	{ title: '[PGM] 椅子樂團',                 type: 'Virtual',   number: '5',  startSec: 45000, endSec: 47400 },
	{ title: '[List] List 1 (ML1)',            type: 'VideoList', number: '6',  startSec: 47400, endSec: 54000, items: TEST_LIST_ITEMS['[List] List 1 (ML1)'] },
	{ title: '[Next On] 血肉果汁機 ft. 陳亞蘭', type: 'Virtual',   number: '19', startSec: 54000, endSec: 76200 },
	{ title: '[PGM] 血肉果汁機 ft. 陳亞蘭',     type: 'Virtual',   number: '20', startSec: 76200, endSec: 78600 },
	{ title: 'Day1 收播字卡',                   type: 'Virtual',   number: '21', startSec: 78600, endSec: 79200 },
]

/**
 * 依目前時刻（時間部分）找出對應的場景索引。
 * 若在排程時間外則回傳 -1。
 */
function getTimeBasedSceneIdx() {
	const now = new Date()
	const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
	return TEST_SCENES.findIndex((s) => nowSec >= s.startSec && nowSec < s.endSec)
}

/**
 * 每個 instance 的測試狀態（pgmIdx、pvwIdx 各自獨立）
 * @type {Map<string, { pgmIdx: number, pvwIdx: number }>}
 */
const testState = new Map([
	['main',  { pgmIdx: 0, pvwIdx: 1 }],
	['spare', { pgmIdx: 0, pvwIdx: 1 }],
])

function getTestState(id) {
	if (!testState.has(id)) testState.set(id, { pgmIdx: 0, pvwIdx: 1 })
	return testState.get(id)
}

function broadcastTestScene(inst, type, idx) {
	const n = TEST_SCENES.length
	const scene = TEST_SCENES[((idx % n) + n) % n]
	if (type === 'pgm') {
		inst.lastPgmTitle = scene.title
		const payload = { type: 'pgm', name: scene.title }
		if (scene.type === 'VideoList') {
			payload.scene_type = 'list'
			// 計算在目前時間點 list 已播放了多少秒（依時間表推算）
			const now = new Date()
			const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
			payload.started = Math.max(0, nowSec - scene.startSec)
		}
		inst.lastPgmPayload = payload
		broadcastToId(inst.id, payload)
	} else {
		inst.lastPvwTitle = scene.title
		broadcastToId(inst.id, { type: 'pvw', name: scene.title })
	}
	return scene.title
}

function startTestMode(inst) {
	if (inst.pollTimer) clearInterval(inst.pollTimer)

	inst.connected = true
	inst.inputs = TEST_SCENES
	broadcastToId(inst.id, { type: 'vmix-status', connected: true })
	broadcastToId(inst.id, { type: 'inputs', inputs: TEST_SCENES })

	const applyTimeBasedState = () => {
		const s = getTestState(inst.id)
		const n = TEST_SCENES.length
		const idx = getTimeBasedSceneIdx()
		const pgmIdx = idx >= 0 ? idx : 0
		const pvwIdx = (pgmIdx + 1) % n
		if (pgmIdx === s.pgmIdx && pvwIdx === s.pvwIdx) return
		s.pgmIdx = pgmIdx
		s.pvwIdx = pvwIdx
		const pgm = broadcastTestScene(inst, 'pgm', pgmIdx)
		const pvw = broadcastTestScene(inst, 'pvw', pvwIdx)
		console.log(`[TEST:${inst.id}] 時間切換 PGM → ${pgm} / PVW → ${pvw}`)
	}

	// 廣播初始狀態
	applyTimeBasedState()
	const s = getTestState(inst.id)
	console.log(`[TEST:${inst.id}] 測試模式啟動（依時間表模擬）PGM=${inst.lastPgmTitle} / PVW=${inst.lastPvwTitle}`)

	// 每秒檢查一次是否需要切換
	inst.pollTimer = setInterval(applyTimeBasedState, 1000)
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
						duration: Math.round(Number(item['@_duration'] ?? 0) / 1000),
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
		const s = getTestState(id)
		const n = TEST_SCENES.length
		instances.push({
			id,
			testMode: TEST_MODE,
			pgm: inst.lastPgmTitle,
			pvw: inst.lastPvwTitle,
			pgmIdx: s.pgmIdx,
			pvwIdx: s.pvwIdx,
			scenes: TEST_SCENES.map((sc, i) => ({ ...sc, isCurrent: i === ((s.pgmIdx % n + n) % n) })),
		})
	}
	res.json({ ok: true, testMode: TEST_MODE, instances })
})

// 手動設定指定 instance 的 PGM 或 PVW（TEST_MODE 下才有效果，但任何時候都可廣播）
// body: { vmixId: 'main', type: 'pgm'|'pvw', name: '場景名稱' }
app.post('/test/set', (req, res) => {
	const { vmixId = 'main', type, name } = req.body ?? {}
	if (!type || !['pgm', 'pvw'].includes(type)) {
		return res.status(400).json({ ok: false, error: 'type 須為 pgm 或 pvw' })
	}
	if (!name) return res.status(400).json({ ok: false, error: '缺少 name 欄位' })

	const inst = vmixInstances.get(vmixId)
	if (!inst) return res.status(404).json({ ok: false, error: `instance '${vmixId}' 不存在` })

	const sceneIdx = TEST_SCENES.findIndex((s) => s.title === name)
	const state = getTestState(vmixId)
	if (sceneIdx !== -1) {
		if (type === 'pgm') state.pgmIdx = sceneIdx
		else state.pvwIdx = sceneIdx
	}

	if (type === 'pgm') {
		inst.lastPgmTitle = name
		broadcastToId(vmixId, { type: 'pgm', name })
	} else {
		inst.lastPvwTitle = name
		broadcastToId(vmixId, { type: 'pvw', name })
	}
	console.log(`[TEST:${vmixId}] 手動設定 ${type.toUpperCase()} → ${name}`)
	res.json({ ok: true, vmixId, type, name })
})

// 手動推進到下一個場景（PGM+PVW 同時往前一格）
// POST /test/next/:id  （id = 'main' | 'spare'）
app.post('/test/next/:id', (req, res) => {
	const { id } = req.params
	const inst = vmixInstances.get(id)
	if (!inst) return res.status(404).json({ ok: false, error: `instance '${id}' 不存在` })

	const s = getTestState(id)
	const n = TEST_SCENES.length
	s.pgmIdx = (s.pgmIdx + 1) % n
	s.pvwIdx = (s.pvwIdx + 1) % n
	const pgm = broadcastTestScene(inst, 'pgm', s.pgmIdx)
	const pvw = broadcastTestScene(inst, 'pvw', s.pvwIdx)
	console.log(`[TEST:${id}] 手動 Next → PGM=${pgm} / PVW=${pvw}`)
	res.json({ ok: true, id, pgm, pvw })
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
	console.log(`[WS] 客戶端連線 ${ip}（vmix=${vmixId}），目前共 ${wss.clients.size} 個`)

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
		console.log(`[WS] 客戶端斷線（vmix=${vmixId}），剩餘 ${wss.clients.size} 個`)
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

	if (TEST_MODE) {
		console.log(`\n⚠️  TEST MODE 已啟用（依南霸天 2026-03-21 時間表模擬 PGM）`)
		console.log(`   測試 API：  http://localhost:${PORT}/test/status`)
		console.log(`   手動切換：  POST http://localhost:${PORT}/test/next/main`)
		console.log(`              POST http://localhost:${PORT}/test/next/spare`)
		console.log(`   手動設定：  POST http://localhost:${PORT}/test/set { vmixId, type, name }\n`)
		startTestMode(mainInst)
		startTestMode(spareInst)
	} else {
		startPolling(mainInst)
		startPolling(spareInst)
		console.log(`MAIN  vMix：  ${mainInst.host}:${VMIX_API_PORT}（id=main）`)
		console.log(`SPARE vMix：  ${spareInst.host}:${VMIX_API_PORT}（id=spare）`)
	}
})
