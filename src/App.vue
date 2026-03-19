<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import csvContent from '../data/rundown.csv?raw'

// ── WebSocket 同步（MAIN + SPARE 雙機）─────────────────────────────────────

// MAIN 狀態（驅動 row 高亮與 list 計時）
const pgmName = ref('')
const pvwName = ref('')
const pgmSceneType = ref('')
const pgmListStartedSec = ref(0)
const pgmListStartedAt = ref(0)
const wsMainConnected = ref(false)
const vmixMainApiConnected = ref(false)

// SPARE 狀態（唯讀顯示，不驅動 row 高亮）
const pgmNameSpare = ref('')
const pvwNameSpare = ref('')
const pgmSceneTypeSpare = ref('')
const pgmListStartedSecSpare = ref(0)
const pgmListStartedAtSpare = ref(0)
const wsSpareConnected = ref(false)
const vmixSpareApiConnected = ref(false)

// 整體 WS 連線指示（兩機都連線才為 true，供 WS 指示燈使用）
const wsConnected = computed(() => wsMainConnected.value && wsSpareConnected.value)

// 場景對應：MAIN / SPARE 共用同一份 mapping
const vmixSceneMap = ref({})
const vmixEditMode = ref(false)

// 兩機各自的 inputs 清單（去重合併後供下拉選單使用）
const vmixKnownScenesMain = ref([])
const vmixKnownScenesSpare = ref([])
const vmixKnownScenes = computed(() => {
	const map = new Map()
	for (const s of vmixKnownScenesSpare.value) map.set(s.title ?? s, s)
	for (const s of vmixKnownScenesMain.value) map.set(s.title ?? s, s)
	return [...map.values()]
})

// 主機 IP 設定
const vmixHostMain = ref('localhost')
const vmixHostSpare = ref('localhost')

let wsMain = null
let wsSpare = null
let wsMainReconnectTimer = null
let wsSpareReconnectTimer = null

function handleWsMessage(id, e) {
	let msg
	try { msg = JSON.parse(e.data) } catch { return }
	const { type, name } = msg
	if (id === 'main') {
		if (type === 'pgm') {
			pgmName.value = name ?? ''
			if (msg.scene_type === 'list' && msg.started != null) {
				pgmSceneType.value = 'list'
				pgmListStartedSec.value = Number(msg.started)
				pgmListStartedAt.value = Date.now()
			} else {
				pgmSceneType.value = msg.scene_type ?? ''
				pgmListStartedSec.value = 0
				pgmListStartedAt.value = 0
			}
		} else if (type === 'pvw') {
			pvwName.value = name ?? ''
		} else if (type === 'inputs') {
			const list = Array.isArray(msg.inputs) ? msg.inputs : []
			vmixKnownScenesMain.value = list
			try { localStorage.setItem('rundown-vmix-known-scenes-main', JSON.stringify(list)) } catch (_) { }
		} else if (type === 'vmix-status') {
			vmixMainApiConnected.value = !!msg.connected
		} else if (type === 'clear') {
			pgmName.value = ''
			pvwName.value = ''
			pgmSceneType.value = ''
			pgmListStartedSec.value = 0
			pgmListStartedAt.value = 0
		}
	} else {
		if (type === 'pgm') {
			pgmNameSpare.value = name ?? ''
			if (msg.scene_type === 'list' && msg.started != null) {
				pgmSceneTypeSpare.value = 'list'
				pgmListStartedSecSpare.value = Number(msg.started)
				pgmListStartedAtSpare.value = Date.now()
			} else {
				pgmSceneTypeSpare.value = msg.scene_type ?? ''
				pgmListStartedSecSpare.value = 0
				pgmListStartedAtSpare.value = 0
			}
		} else if (type === 'pvw') {
			pvwNameSpare.value = name ?? ''
		} else if (type === 'inputs') {
			const list = Array.isArray(msg.inputs) ? msg.inputs : []
			vmixKnownScenesSpare.value = list
			try { localStorage.setItem('rundown-vmix-known-scenes-spare', JSON.stringify(list)) } catch (_) { }
		} else if (type === 'vmix-status') {
			vmixSpareApiConnected.value = !!msg.connected
		} else if (type === 'clear') {
			pgmNameSpare.value = ''
			pvwNameSpare.value = ''
			pgmSceneTypeSpare.value = ''
			pgmListStartedSecSpare.value = 0
			pgmListStartedAtSpare.value = 0
		}
	}
}

function connectWSMain() {
	if (wsMain) {
		wsMain.onopen = wsMain.onmessage = wsMain.onclose = wsMain.onerror = null
		try { wsMain.close() } catch (_) { }
	}
	wsMain = new WebSocket(`ws://${window.location.host}/ws/?vmix=main`)
	wsMain.onopen = () => { wsMainConnected.value = true }
	wsMain.onmessage = (e) => handleWsMessage('main', e)
	wsMain.onclose = () => {
		wsMainConnected.value = false
		wsMainReconnectTimer = setTimeout(connectWSMain, 3000)
	}
	wsMain.onerror = () => { try { wsMain.close() } catch (_) { } }
}

function connectWSSpare() {
	if (wsSpare) {
		wsSpare.onopen = wsSpare.onmessage = wsSpare.onclose = wsSpare.onerror = null
		try { wsSpare.close() } catch (_) { }
	}
	wsSpare = new WebSocket(`ws://${window.location.host}/ws/?vmix=spare`)
	wsSpare.onopen = () => { wsSpareConnected.value = true }
	wsSpare.onmessage = (e) => handleWsMessage('spare', e)
	wsSpare.onclose = () => {
		wsSpareConnected.value = false
		wsSpareReconnectTimer = setTimeout(connectWSSpare, 3000)
	}
	wsSpare.onerror = () => { try { wsSpare.close() } catch (_) { } }
}

// 從 開始時間 取出日期 (YYYY-MM-DD)
function getDate(str) {
	if (!str || typeof str !== 'string') return ''
	return str.trim().slice(0, 10)
}

// 時間顯示為 HH:mm:ss（00:00:00）
function formatTime(str) {
	if (!str || typeof str !== 'string') return ''
	const trimmed = str.trim()
	if (trimmed.length >= 19) return trimmed.slice(11, 19) // YYYY-MM-DD HH:mm:ss
	if (trimmed.length >= 16) return trimmed.slice(11, 16) + ':00'
	return trimmed
}

// 解析 ISO 風格時間字串為 Date（支援 YYYY-MM-DD HH:mm:ss）
function parseDateTime(str) {
	if (!str || typeof str !== 'string') return null
	const trimmed = str.trim().replace(' ', 'T')
	const d = new Date(trimmed)
	return isNaN(d.getTime()) ? null : d
}

// 解析項目欄位：將 [xxx] 視為標籤，回傳 { type: 'tag'|'text', text } 陣列
function parseItemWithTags(str) {
	if (!str || typeof str !== 'string') return []
	const segments = []
	const re = /\[([^\]]+)\]/g
	let match
	let lastIndex = 0
	while ((match = re.exec(str)) !== null) {
		if (match.index > lastIndex) {
			segments.push({ type: 'text', text: str.slice(lastIndex, match.index) })
		}
		segments.push({ type: 'tag', text: match[1] })
		lastIndex = re.lastIndex
	}
	if (lastIndex < str.length) {
		segments.push({ type: 'text', text: str.slice(lastIndex) })
	}
	if (segments.length === 0 && str) segments.push({ type: 'text', text: str })
	return segments
}

/**
 * 依標籤內容與舞台回傳標籤的 Tailwind class（方便事後修改規則）
 * @param {string} tagText - 標籤內文字（如 "Next On", "PGM", "List"）
 * @param {Object} row - 該列資料（含 舞台），PGM 時用來判斷顏色
 * @param {boolean} isDark - 是否深色主題
 * @returns {string} Tailwind 類名
 */
function getTagClasses(tagText, row, isDark) {
	const t = (tagText || '').trim()
	const stage = (row && row['舞台']) ? row['舞台'].trim() : ''

	// Next On → 淺紫色
	if (t === 'Next On') {
		return isDark
			? 'bg-violet-500/25 text-violet-200 border border-violet-500/50'
			: 'bg-violet-200/80 text-violet-800 border border-violet-400/70'
	}

	// PGM → 依舞台
	if (t === 'PGM' || t.startsWith('PGM')) {
		if (stage === '南霸天') {
			return isDark
				? 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/50'
				: 'bg-emerald-200/80 text-emerald-800 border border-emerald-400/70'
		}
		if (stage === '女神龍') {
			return isDark
				? 'bg-pink-500/25 text-pink-200 border border-pink-500/50'
				: 'bg-pink-200/80 text-pink-800 border border-pink-400/70'
		}
	}

	// List → 黃色
	if (t === 'List' || t.startsWith('List')) {
		return isDark
			? 'bg-amber-500/25 text-amber-200 border border-amber-500/50'
			: 'bg-amber-200/80 text-amber-800 border border-amber-400/70'
	}

	// 預設灰色
	return isDark
		? 'bg-stone-700 text-stone-200 border border-stone-500/80'
		: 'bg-stone-200 text-stone-800 border border-stone-400/80'
}

// 計算時間長度，回傳「x 分 x 秒」（超過一小時也用分鐘計）
function getDuration(startStr, endStr) {
	const start = parseDateTime(startStr)
	const end = parseDateTime(endStr)
	if (!start || !end || end <= start) return '—'
	const totalSeconds = Math.round((end - start) / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `<span class="font-mono tabular-nums">${minutes}</span> 分 <span class="font-mono tabular-nums">${seconds}</span> 秒`
}

function parseCSV(text) {
	const lines = text.trim().split(/\r?\n/)
	if (lines.length < 2) return []
	const header = lines[0].split(',').map((h) => h.trim())
	const result = []
	for (let i = 1; i < lines.length; i++) {
		const values = lines[i].split(',').map((v) => v.trim())
		const row = {}
		header.forEach((key, j) => {
			row[key] = values[j] ?? ''
		})
		result.push(row)
	}
	return result
}

const rows = ref(parseCSV(csvContent))

// 明暗色系：預設暗色，存在 localStorage
const isDark = ref(true)

function toggleTheme() {
	isDark.value = !isDark.value
	try {
		localStorage.setItem('rundown-theme', isDark.value ? 'dark' : 'light')
	} catch (_) { }
}

// 目前時間（用於判斷進行中列，每秒更新）
const now = ref(new Date())
let ticker
onMounted(async () => {
	try {
		const stored = localStorage.getItem('rundown-theme')
		if (stored !== null) isDark.value = stored === 'dark'
	} catch (_) { }
	try {
		const storedStage = localStorage.getItem('rundown-stage')
		const storedDate = localStorage.getItem('rundown-date')
		if (storedStage !== null && stageOptions.value.includes(storedStage)) {
			selectedStage.value = storedStage
		} else if (stageOptions.value.length > 0) {
			selectedStage.value = stageOptions.value[0]
		}
		if (storedDate !== null && dateOptions.value.includes(storedDate)) {
			selectedDate.value = storedDate
		}
	} catch (_) { }
	try {
		const storedSceneMap = localStorage.getItem('rundown-vmix-scene-map')
		if (storedSceneMap) vmixSceneMap.value = JSON.parse(storedSceneMap)
		const storedScenesMain = localStorage.getItem('rundown-vmix-known-scenes-main')
		if (storedScenesMain) vmixKnownScenesMain.value = JSON.parse(storedScenesMain)
		const storedScenesSpare = localStorage.getItem('rundown-vmix-known-scenes-spare')
		if (storedScenesSpare) vmixKnownScenesSpare.value = JSON.parse(storedScenesSpare)
		const storedHostMain = localStorage.getItem('rundown-vmix-host-main')
		if (storedHostMain) vmixHostMain.value = storedHostMain
		const storedHostSpare = localStorage.getItem('rundown-vmix-host-spare')
		if (storedHostSpare) vmixHostSpare.value = storedHostSpare
	} catch (_) { }
	// 向伺服器取得目前 vMix 主機設定
	try {
		const [rMain, rSpare] = await Promise.all([
			fetch('/vmix-host/main'),
			fetch('/vmix-host/spare'),
		])
		if (rMain.ok) {
			const d = await rMain.json()
			vmixHostMain.value = d.host ?? 'localhost'
			vmixMainApiConnected.value = !!d.connected
		}
		if (rSpare.ok) {
			const d = await rSpare.json()
			vmixHostSpare.value = d.host ?? 'localhost'
			vmixSpareApiConnected.value = !!d.connected
		}
	} catch (_) { }
	ticker = setInterval(() => {
		now.value = new Date()
	}, 1000)
	document.addEventListener('click', onDocumentClick)
	connectWSMain()
	connectWSSpare()
})
onUnmounted(() => {
	if (ticker) clearInterval(ticker)
	if (wsMainReconnectTimer) clearTimeout(wsMainReconnectTimer)
	if (wsSpareReconnectTimer) clearTimeout(wsSpareReconnectTimer)
	if (wsMain) { wsMain.onopen = wsMain.onmessage = wsMain.onclose = wsMain.onerror = null; try { wsMain.close() } catch (_) { } }
	if (wsSpare) { wsSpare.onopen = wsSpare.onmessage = wsSpare.onclose = wsSpare.onerror = null; try { wsSpare.close() } catch (_) { } }
	document.removeEventListener('click', onDocumentClick)
})

// 唯一舞台（依 CSV 出現順序）
const stageOptions = computed(() => {
	const set = new Set()
	const list = []
	for (const r of rows.value) {
		const s = r['舞台']
		if (s && !set.has(s)) {
			set.add(s)
			list.push(s)
		}
	}
	return list
})

// 唯一日期（排序）
const dateOptions = computed(() => {
	const set = new Set()
	for (const r of rows.value) {
		const d = getDate(r['開始時間'])
		if (d) set.add(d)
	}
	return [...set].sort()
})

// 預設選第一個舞台與第一個日期
const selectedStage = ref(stageOptions.value[0] ?? '')
const selectedDate = ref(dateOptions.value[0] ?? '')

// 將選擇的舞台、日期寫入 localStorage
function saveStageDate() {
	try {
		localStorage.setItem('rundown-stage', selectedStage.value)
		localStorage.setItem('rundown-date', selectedDate.value)
	} catch (_) { }
}
watch(selectedStage, saveStageDate)
watch(selectedDate, saveStageDate)

// 設定選單開關
const settingsOpen = ref(false)
const settingsRef = ref(null)

function onDocumentClick(e) {
	if (settingsRef.value && !settingsRef.value.contains(e.target)) {
		settingsOpen.value = false
	}
}

// 以「舞台|開始時間|項目」作為列的唯一識別鍵
function getRowKey(row) {
	return `${row['舞台']}|${row['開始時間']}|${row['項目']}`
}

// 儲存 vmixSceneMap 到 localStorage（MAIN/SPARE 共用）
function saveVmixSceneMap() {
	try {
		localStorage.setItem('rundown-vmix-scene-map', JSON.stringify(vmixSceneMap.value))
	} catch (_) { }
}

// 儲存指定 id（'main' | 'spare'）的 vMix 主機設定到伺服器
async function saveVmixHost(id) {
	const host = (id === 'main' ? vmixHostMain.value : vmixHostSpare.value).trim()
	if (!host) return
	try {
		await fetch(`/vmix-host/${id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ host }),
		})
		try { localStorage.setItem(`rundown-vmix-host-${id}`, host) } catch (_) { }
	} catch (_) { }
}


// 依場景名稱從 vmixKnownScenes 找到完整物件
function getVmixScene(title) {
	if (!title) return null
	return vmixKnownScenes.value.find((s) => (s.title ?? s) === title) ?? null
}

// 判斷該列對應的 vMix 場景是否為 VideoList 類型
function hasListTag(row) {
	const sceneName = vmixSceneMap.value[getRowKey(row)]
	if (!sceneName) return false
	const scene = getVmixScene(sceneName)
	return scene ? scene.type === 'VideoList' : false
}

// 從 vMix 場景取得 List 子項目（{ cue, duration }）
function getListItems(row) {
	const sceneName = vmixSceneMap.value[getRowKey(row)]
	if (!sceneName) return []
	const scene = getVmixScene(sceneName)
	if (!scene || !Array.isArray(scene.items)) return []
	return scene.items.map((item) => ({ cue: item.name, duration: item.duration }))
}

// 判斷該列是否為目前播放中的 PGM list
function isPgmListRow(row) {
	return pgmSceneType.value === 'list'
		&& !!pgmName.value
		&& vmixSceneMap.value[getRowKey(row)] === pgmName.value
}

// 目前 PGM list 已播秒數（每秒隨 now 更新）
// elapsed = started（WS 送來的基準值）+ 收到後累計的秒數
const pgmListElapsed = computed(() => {
	if (pgmSceneType.value !== 'list' || !pgmListStartedAt.value) return null
	return Math.max(0, pgmListStartedSec.value + (now.value.getTime() - pgmListStartedAt.value) / 1000)
})

// MAIN List 預計結束時間 vs 表定結束時間的秒數差（正 = 延遲，負 = 超前，null = 無資料）
// 公式：預計結束 = 現在時間 + 剩餘秒數；表定結束 = row['結束時間']
const pgmListScheduleDiff = computed(() => {
	if (pgmListElapsed.value == null) return null
	const row = rows.value.find(r => isPgmListRow(r))
	if (!row) return null
	const endSec = timeStrToSeconds(row['結束時間'])
	if (endSec == null) return null
	const items = getListItems(row)
	const totalDuration = items.reduce((s, item) => s + item.duration, 0)
	const remaining = Math.max(0, totalDuration - pgmListElapsed.value)
	const estimatedEndSec = nowTimeSeconds.value + remaining
	return Math.round(estimatedEndSec - endSec)
})

// 依 elapsed 計算目前播到第幾個 cue（0-based index），找不到回傳 -1
function getListCurrentCueIdx(row) {
	if (!isPgmListRow(row)) return -1
	const elapsed = pgmListElapsed.value
	if (elapsed == null) return -1
	const items = getListItems(row)
	let acc = 0
	for (let i = 0; i < items.length; i++) {
		acc += items[i].duration
		if (elapsed < acc) return i
	}
	return items.length - 1
}

// 回傳 { elapsed, remaining } 已播 / 後結束的格式化字串；非 list pgm 時回傳 null
function getListSummary(row) {
	if (!isPgmListRow(row)) return null
	const elapsed = pgmListElapsed.value
	if (elapsed == null) return null
	const items = getListItems(row)
	const total = items.reduce((s, item) => s + item.duration, 0)
	const remaining = Math.max(0, total - elapsed)
	return {
		elapsed: formatListDuration(Math.floor(elapsed)),
		remaining: formatListDuration(Math.floor(remaining)),
	}
}

// 回傳目前 cue 自身的 { elapsed, remaining }；非 list pgm 或無 active cue 時回傳 null
function getListCurrentCueProgress(row) {
	if (!isPgmListRow(row)) return null
	const elapsed = pgmListElapsed.value
	if (elapsed == null) return null
	const items = getListItems(row)
	let acc = 0
	for (let i = 0; i < items.length; i++) {
		const cueStart = acc
		acc += items[i].duration
		if (elapsed < acc) {
			const cueElapsed = elapsed - cueStart
			const cueRemaining = Math.max(0, items[i].duration - cueElapsed)
			return {
				elapsed: formatListDuration(Math.floor(cueElapsed)),
				remaining: formatListDuration(Math.floor(cueRemaining)),
			}
		}
	}
	return null
}

// ── SPARE list 計時（與 MAIN 版本對稱）────────────────────────────────────
const pgmListElapsedSpare = computed(() => {
	if (pgmSceneTypeSpare.value !== 'list' || !pgmListStartedAtSpare.value) return null
	return Math.max(0, pgmListStartedSecSpare.value + (now.value.getTime() - pgmListStartedAtSpare.value) / 1000)
})

function isPgmListRowSpare(row) {
	return pgmSceneTypeSpare.value === 'list'
		&& !!pgmNameSpare.value
		&& vmixSceneMap.value[getRowKey(row)] === pgmNameSpare.value
}

function getListCurrentCueIdxSpare(row) {
	if (!isPgmListRowSpare(row)) return -1
	const elapsed = pgmListElapsedSpare.value
	if (elapsed == null) return -1
	const items = getListItems(row)
	let acc = 0
	for (let i = 0; i < items.length; i++) {
		acc += items[i].duration
		if (elapsed < acc) return i
	}
	return items.length - 1
}

function getListSummarySpare(row) {
	if (!isPgmListRowSpare(row)) return null
	const elapsed = pgmListElapsedSpare.value
	if (elapsed == null) return null
	const items = getListItems(row)
	const total = items.reduce((s, item) => s + item.duration, 0)
	const remaining = Math.max(0, total - elapsed)
	return {
		elapsed: formatListDuration(Math.floor(elapsed)),
		remaining: formatListDuration(Math.floor(remaining)),
	}
}

function getListCurrentCueProgressSpare(row) {
	if (!isPgmListRowSpare(row)) return null
	const elapsed = pgmListElapsedSpare.value
	if (elapsed == null) return null
	const items = getListItems(row)
	let acc = 0
	for (let i = 0; i < items.length; i++) {
		const cueStart = acc
		acc += items[i].duration
		if (elapsed < acc) {
			const cueElapsed = elapsed - cueStart
			const cueRemaining = Math.max(0, items[i].duration - cueElapsed)
			return {
				elapsed: formatListDuration(Math.floor(cueElapsed)),
				remaining: formatListDuration(Math.floor(cueRemaining)),
			}
		}
	}
	return null
}

// 將秒數字串（如 "120s"、"180s_早"）轉為 MM:SS 格式（如 "02:00"、"03:00 早"），也可能沒有 s
function formatListDuration(sec) {
	// 計算分鐘與秒數
	const minutes = Math.floor(sec / 60)
	const seconds = sec % 60

	// 使用 padStart(2, '0') 確保雙位數格式
	const mm = String(minutes).padStart(2, '0')
	const ss = String(seconds).padStart(2, '0')

	return `${mm}:${ss}`
}

// 時鐘顯示 HH:mm:ss
const clockText = computed(() => {
	const d = now.value
	const h = String(d.getHours()).padStart(2, '0')
	const m = String(d.getMinutes()).padStart(2, '0')
	const s = String(d.getSeconds()).padStart(2, '0')
	return `${h}:${m}:${s}`
})

// 依選取的舞台、日期篩選
const filteredRows = computed(() => {
	const stage = selectedStage.value
	const date = selectedDate.value
	return rows.value.filter((r) => {
		const matchStage = !stage || r['舞台'] === stage
		const matchDate = !date || getDate(r['開始時間']) === date
		return matchStage && matchDate
	})
})

// 時間字串轉成「當日 0:00 起算的秒數」（只看時間不管日期）
function timeStrToSeconds(str) {
	if (!str || typeof str !== 'string') return null
	const trimmed = str.trim()
	if (trimmed.length < 19) return null
	const part = trimmed.slice(11, 19) // HH:mm:ss
	const [h, m, s] = part.split(':').map(Number)
	if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null
	return h * 3600 + m * 60 + s
}

// 目前時間（當日 0:00 起算的秒數）
const nowTimeSeconds = computed(() => {
	const d = now.value
	return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
})

// 判斷「現在時間」是否落在該列的時間區間內（只看時間，跨日區間也支援）
function isTimeInRange(nowSec, startStr, endStr) {
	const startSec = timeStrToSeconds(startStr)
	const endSec = timeStrToSeconds(endStr)
	if (startSec == null || endSec == null) return false
	if (endSec > startSec) return nowSec >= startSec && nowSec < endSec
	// 跨日：例如 23:00 ~ 01:00 → startSec..86400 或 0..endSec
	return nowSec >= startSec || nowSec < endSec
}

// 依「只看時間」判斷該列狀態：'current' 目前流程 | 'past' 已過 | 'future' 未到
function getRowTimeStatus(row) {
	const t = nowTimeSeconds.value
	if (isTimeInRange(t, row['開始時間'], row['結束時間'])) return 'current'
	const startSec = timeStrToSeconds(row['開始時間'])
	const endSec = timeStrToSeconds(row['結束時間'])
	if (startSec == null || endSec == null) return 'future'
	// 已過 = 該段結束時間已過（跨日時：在 endSec 與 startSec 之間）
	const past = endSec > startSec ? t >= endSec : (t >= endSec && t < startSec)
	return past ? 'past' : 'future'
}

// 進行中時，回傳「距離結束還有 x 分 x 秒」；否則回傳 null。一律只看時間（當作今天），不跨日。
function getTimeLeftUntilEnd(row) {
	const t = nowTimeSeconds.value
	if (!isTimeInRange(t, row['開始時間'], row['結束時間'])) return null
	const endSec = timeStrToSeconds(row['結束時間'])
	if (endSec == null) return null
	const leftSec = endSec - t
	if (leftSec <= 0) return null
	const minutes = Math.floor(leftSec / 60).toString().padStart(2, '0')
	const seconds = Math.floor(leftSec % 60).toString().padStart(2, '0')
	return `${minutes}:${seconds}`
}

// 未開始的流程，回傳「再 x 分 x 秒」後開始；否則回傳 null。一律只看時間（當作今天），不跨日。
function getTimeUntilStart(row) {
	if (getRowTimeStatus(row) !== 'future') return null
	const t = nowTimeSeconds.value
	const startSec = timeStrToSeconds(row['開始時間'])
	if (startSec == null) return null
	const leftSec = startSec - t
	if (leftSec <= 0) return null
	const minutes = Math.floor(leftSec / 60).toString().padStart(2, '0')
	const seconds = Math.floor(leftSec % 60).toString().padStart(2, '0')
	return `${minutes}:${seconds}`
}

// 進行中的流程，回傳 0~100 的進度百分比；否則回傳 0
function getRowProgress(row) {
	if (getRowTimeStatus(row) !== 'current') return 0
	const startSec = timeStrToSeconds(row['開始時間'])
	const endSec = timeStrToSeconds(row['結束時間'])
	if (startSec == null || endSec == null || endSec <= startSec) return 0
	const elapsed = nowTimeSeconds.value - startSec
	const total = endSec - startSec
	return Math.min(100, Math.max(0, (elapsed / total) * 100))
}

// 進行中的流程，回傳「已開始 x 分 x 秒」；否則回傳 null。一律只看時間（當作今天），不跨日。
function getTimeElapsedSinceStart(row) {
	if (getRowTimeStatus(row) !== 'current') return null
	const t = nowTimeSeconds.value
	const startSec = timeStrToSeconds(row['開始時間'])
	if (startSec == null) return null
	const elapsedSec = t - startSec
	if (elapsedSec < 0) return null
	const minutes = Math.floor(elapsedSec / 60).toString().padStart(2, '0')
	const seconds = Math.floor(elapsedSec % 60).toString().padStart(2, '0')
	return `${minutes}:${seconds}`
}

// 下一個流程的列索引（篩選後列表中第一個 status 為 future 的列）
const nextRowIndex = computed(() => {
	const list = filteredRows.value
	for (let i = 0; i < list.length; i++) {
		if (getRowTimeStatus(list[i]) === 'future') return i
	}
	return -1
})

// 表格內進行中高亮：start <= now < end（含日期）
const currentRowIndex = computed(() => {
	const t = now.value.getTime()
	for (let i = 0; i < filteredRows.value.length; i++) {
		const r = filteredRows.value[i]
		const start = parseDateTime(r['開始時間'])
		const end = parseDateTime(r['結束時間'])
		if (start && end && t >= start.getTime() && t < end.getTime()) return i
	}
	return -1
})

</script>

<template>
	<div class="h-screen max-h-screen overflow-hidden flex flex-col p-6 font-sans transition-colors relative"
		:class="isDark ? 'bg-stone-950 text-stone-100' : 'bg-stone-300 text-stone-900'">
		<!-- 連線狀態指示（MAIN + SPARE）-->
		<div class="fixed top-4 right-[8.5rem] z-20 flex items-center gap-3 text-xs"
			:class="isDark ? 'text-stone-400' : 'text-stone-600'">
			<span class="flex items-center gap-1"
				:title="`MAIN：WS ${wsMainConnected ? '已連線' : '未連線'}，vMix ${vmixMainApiConnected ? '已連線' : '未連線'}`">
				<span class="w-2 h-2 rounded-full shrink-0"
					:class="vmixMainApiConnected ? 'bg-emerald-500 animate-pulse' : 'bg-stone-500'"></span>
				<span>MAIN</span>
			</span>
			<span class="flex items-center gap-1"
				:title="`SPARE：WS ${wsSpareConnected ? '已連線' : '未連線'}，vMix ${vmixSpareApiConnected ? '已連線' : '未連線'}`">
				<span class="w-2 h-2 rounded-full shrink-0"
					:class="vmixSpareApiConnected ? 'bg-emerald-500 animate-pulse' : 'bg-stone-500'"></span>
				<span>SPARE</span>
			</span>
			<span class="flex items-center gap-1"
				:title="`WebSocket：MAIN ${wsMainConnected ? '✓' : '✗'} / SPARE ${wsSpareConnected ? '✓' : '✗'}`">
				<span class="w-2 h-2 rounded-full shrink-0"
					:class="wsConnected ? 'bg-emerald-500 animate-pulse' : (wsMainConnected || wsSpareConnected) ? 'bg-yellow-500 animate-pulse' : 'bg-stone-500'"></span>
				<span class="hidden sm:inline">WS</span>
			</span>
		</div>

		<!-- 右上角設定按鈕 + 下拉選單 -->
		<div ref="settingsRef" class="fixed top-4 right-4 z-20">
			<button type="button"
				class="rounded-lg px-3 py-2 border focus:outline-none focus:ring-2 focus:ring-amber-500/50 flex items-center gap-2 shadow"
				:class="isDark ? 'bg-stone-800/90 border-stone-600 text-stone-100 hover:bg-stone-700' : 'bg-stone-200/90 border-stone-400 text-stone-900 hover:bg-stone-300'"
				@click="settingsOpen = !settingsOpen" :aria-label="settingsOpen ? '關閉設定' : '開啟設定'">
				<span>⚙️ 設定</span>
			</button>
			<div v-show="settingsOpen"
				class="absolute right-0 top-full mt-2 rounded-xl border shadow-lg py-3 px-4 min-w-[200px]"
				:class="isDark ? 'bg-stone-800 border-stone-600' : 'bg-stone-200 border-stone-400'">
				<div class="space-y-3">
					<!-- vMix 主機設定（MAIN + SPARE）-->
					<div class="space-y-2">
						<p class="text-xs font-medium" :class="isDark ? 'text-stone-500' : 'text-stone-600'">vMix 主機</p>
						<!-- MAIN -->
						<div>
							<div class="flex items-center gap-1.5 mb-1">
								<span class="text-xs font-bold">MAIN</span>
							</div>
							<div class="flex gap-1.5">
								<input v-model="vmixHostMain" type="text" placeholder="localhost"
									class="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm border focus:outline-none focus:ring-2 focus:ring-sky-500/50"
									:class="isDark ? 'bg-stone-700 border-stone-600 text-stone-100 placeholder:text-stone-500' : 'bg-white border-stone-400 text-stone-900 placeholder:text-stone-400'"
									@keydown.enter="saveVmixHost('main')" />
								<button type="button" @click="saveVmixHost('main')"
									class="shrink-0 rounded-lg px-3 py-2 text-sm border focus:outline-none focus:ring-2 focus:ring-sky-500/50"
									:class="isDark ? 'bg-stone-600 border-stone-500 text-stone-100 hover:bg-stone-500' : 'bg-stone-200 border-stone-400 text-stone-800 hover:bg-stone-300'">
									套用
								</button>
							</div>
						</div>
						<!-- SPARE -->
						<div>
							<div class="flex items-center gap-1.5 mb-1">
								<span class="text-xs font-bold">SPARE</span>
							</div>
							<div class="flex gap-1.5">
								<input v-model="vmixHostSpare" type="text" placeholder="localhost"
									class="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm border focus:outline-none focus:ring-2 focus:ring-amber-500/50"
									:class="isDark ? 'bg-stone-700 border-stone-600 text-stone-100 placeholder:text-stone-500' : 'bg-white border-stone-400 text-stone-900 placeholder:text-stone-400'"
									@keydown.enter="saveVmixHost('spare')" />
								<button type="button" @click="saveVmixHost('spare')"
									class="shrink-0 rounded-lg px-3 py-2 text-sm border focus:outline-none focus:ring-2 focus:ring-amber-500/50"
									:class="isDark ? 'bg-stone-600 border-stone-500 text-stone-100 hover:bg-stone-500' : 'bg-stone-200 border-stone-400 text-stone-800 hover:bg-stone-300'">
									套用
								</button>
							</div>
						</div>
					</div>
					<hr :class="isDark ? 'border-stone-600' : 'border-stone-400'" />
					<div>
						<label class="block text-xs font-medium mb-1"
							:class="isDark ? 'text-stone-500' : 'text-stone-600'">舞台</label>
						<select v-model="selectedStage"
							class="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 border"
							:class="isDark ? 'bg-stone-700 border-stone-600 text-stone-100' : 'bg-white border-stone-400 text-stone-900'">
							<option v-for="s in stageOptions" :key="s" :value="s">{{ s }}</option>
						</select>
					</div>
					<div>
						<label class="block text-xs font-medium mb-1"
							:class="isDark ? 'text-stone-500' : 'text-stone-600'">日期</label>
						<select v-model="selectedDate"
							class="w-full rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 border"
							:class="isDark ? 'bg-stone-700 border-stone-600 text-stone-100' : 'bg-white border-stone-400 text-stone-900'">
							<option v-for="d in dateOptions" :key="d" :value="d">{{ d }}</option>
						</select>
					</div>
					<label class="block text-xs font-medium mb-1"
						:class="isDark ? 'text-stone-500' : 'text-stone-600'">主題</label>
					<button type="button"
						class="w-full rounded-lg px-3 py-2 border text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 flex items-center justify-center gap-2"
						:class="isDark ? 'bg-stone-700 border-stone-600 text-stone-100 hover:bg-stone-600' : 'bg-stone-100 border-stone-400 text-stone-900 hover:bg-stone-200'"
						@click="toggleTheme" :aria-label="isDark ? '切換為淺色' : '切換為深色'">
						<span v-if="isDark">☀️ 淺色</span>
						<span v-else>🌙 深色</span>
					</button>
				</div>
			</div>
		</div>

		<!-- 正上方時鐘與計時器 -->
		<div class="flex flex-wrap items-center justify-center gap-20 mb-4 pt-2 shrink-0">
			<div class="text-center">
				<div class="text-sm mb-1" :class="isDark ? 'text-stone-400' : 'text-stone-500'">目前時間</div>
				<div class="inline-block font-mono text-7xl tracking-wider tabular-nums"
					:class="isDark ? 'text-stone-200' : 'text-stone-800'">
					{{ clockText }}
				</div>
			</div>
			<div class="text-center">
				<template v-if="pgmListScheduleDiff !== null">
					<div class="text-sm mb-1 font-semibold"
						:class="Math.abs(pgmListScheduleDiff) < 1 ? 'text-emerald-600' : pgmListScheduleDiff > 0 ? 'text-red-500' : 'text-sky-500'">
						<template v-if="Math.abs(pgmListScheduleDiff) < 1">準時</template>
						<template v-else-if="pgmListScheduleDiff > 0">延遲</template>
						<template v-else>超前</template>
					</div>
					<div class="font-mono text-4xl tracking-wider tabular-nums"
						:class="isDark ? 'text-stone-200' : 'text-stone-800'">
						{{ String(Math.floor(Math.abs(pgmListScheduleDiff) / 60)).padStart(2, '0') }}:{{
							String(Math.abs(pgmListScheduleDiff) % 60).padStart(2, '0') }}
					</div>
				</template>
				<template v-else>
					<div class="text-sm mb-1" :class="isDark ? 'text-stone-400' : 'text-stone-500'">　</div>
					<div class="font-mono text-4xl tracking-wider tabular-nums"
						:class="isDark ? 'text-stone-600' : 'text-stone-400'">
						--:--
					</div>
				</template>
			</div>
		</div>

		<!-- 表格區域：可捲動，不撐高頁面 -->
		<div class="flex-1 min-h-0 flex flex-col rounded-xl border overflow-hidden"
			:class="isDark ? 'border-stone-700/80 bg-stone-900/60' : 'border-stone-400 bg-stone-200/90'">
			<div class="overflow-auto flex-1 min-h-0">
				<table class="w-full text-left border-collapse table-fixed">
					<thead>
						<tr class="sticky top-0 z-10 border-b font-semibold text-sm"
							:class="isDark ? 'bg-stone-800 border-stone-600 text-stone-200' : 'bg-stone-300 border-stone-400 text-stone-800'">
							<th class="w-[20rem] py-2.5 px-4 text-left">項目</th>
							<th class="w-[20rem] py-2.5 px-4 text-left">表定時間</th>
							<th class="w-[10rem] py-2.5 px-4 text-left">In Overlay</th>
							<th class="w-[15rem] py-2.5 px-2 text-center">
								vMix
								<button type="button"
									class="ml-1.5 rounded px-1.5 py-0.5 text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500/50"
									:class="vmixEditMode
										? (isDark ? 'bg-amber-500/30 border-amber-500/60 text-amber-300 hover:bg-amber-500/40' : 'bg-amber-300/60 border-amber-500/60 text-amber-800 hover:bg-amber-300/80')
										: (isDark ? 'bg-stone-700 border-stone-500 text-stone-300 hover:bg-stone-600' : 'bg-stone-200 border-stone-400 text-stone-700 hover:bg-stone-300')"
									@click="vmixEditMode = !vmixEditMode">
									{{ vmixEditMode ? '完成' : '場景' }}
								</button>
							</th>
						</tr>
					</thead>
					<tbody>
						<template v-for="(row, i) in filteredRows" :key="i">
							<tr class="transition-colors" :class="[
								i === currentRowIndex
									? isDark
										? 'bg-amber-500/25 border-l-4 border-amber-500 border-stone-700/60'
										: 'bg-amber-200/60 border-l-4 border-amber-500 border-stone-400'
									: isDark
										? 'border-stone-700/60'
										: 'border-stone-400',
								hasListTag(row) ? '' : 'border-b'
							]">
								<td class="w-[20rem] py-2.5 px-4 font-bold overflow-hidden" :class="[
									i === currentRowIndex ? (isDark ? 'text-blue-400' : 'text-blue-600') : (isDark ? 'text-stone-200' : 'text-stone-800')
								]">
									<span v-if="i === currentRowIndex"
										class="inline-flex items-center gap-1.5 flex-wrap">
										<span
											class="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0"
											title="進行中"></span>
										<template v-for="(seg, k) in parseItemWithTags(row['項目'])" :key="k">
											<span v-if="seg.type === 'tag'"
												class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium shrink-0 mr-2 mb-1 border"
												:class="getTagClasses(seg.text, row, isDark)">{{ seg.text }}</span>
											<span v-else class="mr-1">{{ seg.text }}</span>
										</template>
									</span>
									<template v-else>
										<template v-for="(seg, k) in parseItemWithTags(row['項目'])" :key="k">
											<span v-if="seg.type === 'tag'"
												class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium shrink-0 mr-2 mb-1 border"
												:class="getTagClasses(seg.text, row, isDark)">{{ seg.text }}</span>
											<span v-else class="mr-1">{{ seg.text }}</span>
										</template>
									</template>
									<span class="block text-sm overflow-hidden text-stone-500 text-normal pt-1">{{
										row['備註'] }}</span>
								</td>
								<td class="py-2.5 px-4 text-sm overflow-hidden"
									:class="isDark ? 'text-stone-300' : 'text-stone-700'">
									<span class="font-mono">{{ formatTime(row['開始時間']) }} ~ {{ formatTime(row['結束時間'])
									}}</span>・
									<span v-html="getDuration(row['開始時間'], row['結束時間'])"></span>

									<br>
									<template v-if="getRowTimeStatus(row) === 'current' && getTimeLeftUntilEnd(row)">
										<div class="mt-2.5 h-2.5 rounded-full overflow-hidden"
											:class="isDark ? 'bg-stone-700' : 'bg-stone-300'">
											<div class="h-full rounded-full transition-all duration-1000 bg-sky-500"
												:style="{ width: getRowProgress(row) + '%' }"></div>
										</div>
										<div class="flex items-center justify-between font-mono font-medium"
											:class="isDark ? 'text-stone-200' : 'text-stone-500'">
											<span v-if="getTimeElapsedSinceStart(row)">{{ getTimeElapsedSinceStart(row)
												}}</span>
											<span v-else></span>
											<span>-{{ getTimeLeftUntilEnd(row) }}</span>
										</div>
									</template>
								</td>
								<td class="py-2.5 px-2 align-middle text-center text-sm"
									:class="isDark ? 'text-stone-400' : 'text-stone-600'">
								</td>
								<!-- MAIN vMix 欄（含編輯 dropdown）場景名稱只顯示於此欄 -->
								<td class="py-2.5 px-2 align-middle text-center">
									<template v-if="vmixEditMode">
										<select :value="vmixSceneMap[getRowKey(row)] ?? ''"
											@change="e => { vmixSceneMap[getRowKey(row)] = e.target.value; saveVmixSceneMap() }"
											class="w-full rounded px-1.5 py-1 text-xs border focus:outline-none focus:ring-2 focus:ring-amber-500/50"
											:class="isDark ? 'bg-stone-700 border-stone-500 text-stone-100' : 'bg-white border-stone-400 text-stone-900'">
											<option value="">—</option>
											<option v-for="scene in vmixKnownScenes" :key="scene.title ?? scene"
												:value="scene.title ?? scene">{{
													scene.title ?? scene }}</option>
										</select>
									</template>
									<template v-else>
										<template v-if="vmixSceneMap[getRowKey(row)]">
											<!-- 場景名稱，顏色依 MAIN pgm/pvw 狀態 -->
											<span class="text-xs font-medium break-all leading-tight"
												:class="(isDark ? 'text-stone-400' : 'text-stone-500')">
												{{ vmixSceneMap[getRowKey(row)] }}
											</span>
											<!-- 狀態標籤：MAIN PGM / MAIN PVW / SPARE PGM / SPARE PVW -->
											<div class="flex flex-row flex-wrap items-center justify-center gap-2 mt-1">
												<span v-if="pgmName && vmixSceneMap[getRowKey(row)] === pgmName"
													class="inline-flex items-center rounded px-1.5 py-0.5 text-[13px] font-bold bg-red-600 text-white">
													MAIN PGM
												</span>
												<span v-if="pvwName && vmixSceneMap[getRowKey(row)] === pvwName"
													class="inline-flex items-center rounded px-1.5 py-0.5 text-[13px] font-bold bg-green-600 text-white">
													MAIN PVW
												</span>
												<span
													v-if="pgmNameSpare && vmixSceneMap[getRowKey(row)] === pgmNameSpare"
													class="inline-flex items-center rounded px-1.5 py-0.5 text-[13px] font-bold bg-red-100 text-red-600">
													SPARE PGM
												</span>
												<span
													v-if="pvwNameSpare && vmixSceneMap[getRowKey(row)] === pvwNameSpare"
													class="inline-flex items-center rounded px-1.5 py-0.5 text-[13px] font-bold bg-green-100 text-green-600">
													SPARE PVW
												</span>
											</div>
										</template>
										<span v-else :class="isDark ? 'text-stone-600' : 'text-stone-400'">—</span>
									</template>
								</td>
							</tr>
							<!-- List 子列：當 Tag == List 時顯示 -->
							<tr v-if="hasListTag(row)" class="border-b"
								:class="isDark ? 'border-stone-700/60' : 'border-stone-400'">
								<td></td>
								<td colspan="3" class="pb-4 px-3">
									<!-- v-for 單元素技巧：一次計算 MAIN + SPARE 所有值，避免重複呼叫 -->
									<template v-for="[summary, currentIdx, cueProgress, summarySpare, currentIdxSpare, cueProgressSpare] in [[
										getListSummary(row), getListCurrentCueIdx(row), getListCurrentCueProgress(row),
										getListSummarySpare(row), getListCurrentCueIdxSpare(row), getListCurrentCueProgressSpare(row)
									]]" :key="'list-meta'">
										<table class="w-full text-xs border-collapse rounded-lg overflow-hidden"
											:class="isDark ? 'border border-stone-600/50' : 'border border-stone-400/60'">
											<thead>
												<tr
													:class="isDark ? 'bg-stone-700/60 text-stone-300 border-b border-stone-600/50' : 'bg-stone-300/80 text-stone-700 border-b border-stone-400/60'">
													<th class="text-left px-3 py-1 font-semibold">Cue</th>
													<th class="text-right px-3 py-1 font-semibold w-20">長度</th>
													<th
														class="text-center px-2 py-1 font-semibold w-[12rem] text-[10px]">
														MAIN<br>
														<template v-if="summary">
															<span :class="isDark ? 'text-stone-300' : 'text-stone-700'">
																<span class="font-mono tabular-nums">{{
																	summary.elapsed
																}}</span>
																　-<span class="font-mono tabular-nums">{{
																	summary.remaining
																}}</span>
															</span>
															<span v-if="pgmListScheduleDiff !== null"
																class="block font-mono tabular-nums mt-0.5 font-bold"
																:class="Math.abs(pgmListScheduleDiff) < 1
																	? 'text-emerald-600'
																	: pgmListScheduleDiff > 0
																		? 'text-red-400'
																		: 'text-sky-400'">
																<template
																	v-if="Math.abs(pgmListScheduleDiff) < 1">準時</template>
																<template v-else-if="pgmListScheduleDiff > 0">延遲 {{
																	pgmListScheduleDiff }}s</template>
																<template v-else>超前 {{ Math.abs(pgmListScheduleDiff)
																	}}s</template>
															</span>
														</template>
													</th>
													<th
														class="text-center px-2 py-1 font-semibold w-[12rem] text-[10px]">
														SPARE<br>
														<template v-if="summarySpare">
															<span :class="isDark ? 'text-stone-300' : 'text-stone-700'">
																<span class="font-mono tabular-nums">{{
																	summarySpare.elapsed
																}}</span>
																　- <span class="font-mono tabular-nums">{{
																	summarySpare.remaining
																}}</span>
															</span>
														</template>
													</th>
												</tr>
											</thead>
											<tbody>
												<template v-for="(item, j) in getListItems(row)" :key="j">
													<tr v-if="item !== null" class="border-b" :class="[
														j === currentIdx
															? isDark ? 'bg-amber-500/20 border-amber-500/40' : 'bg-amber-100/80 border-amber-400/50'
															: j === currentIdxSpare
																? isDark ? 'bg-orange-500/10 border-orange-500/30' : 'bg-orange-50 border-orange-300/40'
																: isDark ? 'bg-stone-800/60 border-stone-600/30' : 'bg-stone-100/90 border-stone-400/30'
													]">
														<!-- cue 名稱 -->
														<td class="px-3 py-1" :class="j === currentIdx
															? (isDark ? 'text-amber-200 font-semibold' : 'text-amber-800 font-semibold')
															: j === currentIdxSpare
																? (isDark ? 'text-orange-200' : 'text-orange-800')
																: ''">
															{{ item.cue }}
														</td>
														<!-- 長度 -->
														<td class="px-3 py-1 text-right tabular-nums font-mono"
															:class="isDark ? 'text-stone-300' : 'text-stone-600'">
															{{ formatListDuration(item.duration) }}
														</td>
														<!-- MAIN 指示欄 -->
														<td class="px-2 py-1 text-center align-top">
															<span v-if="j === currentIdx"
																class="text-amber-400 font-bold">▶</span>
															<span v-if="j === currentIdx && cueProgress"
																class="block font-mono tabular-nums text-[10px] leading-tight mt-0.5"
																:class="isDark ? 'text-amber-400/70' : 'text-amber-700'">
																{{ cueProgress.elapsed }}　- {{
																	cueProgress.remaining }}
															</span>
														</td>
														<!-- SPARE 指示欄 -->
														<td class="px-2 py-1 text-center align-top">
															<span v-if="j === currentIdxSpare"
																class="text-amber-400 font-bold">▶</span>
															<span v-if="j === currentIdxSpare && cueProgressSpare"
																class="block font-mono tabular-nums text-[10px] leading-tight mt-0.5"
																:class="isDark ? 'text-amber-400/70' : 'text-amber-700'">
																{{ cueProgressSpare.elapsed }}　- {{
																	cueProgressSpare.remaining }}
															</span>
														</td>
													</tr>
												</template>
											</tbody>
										</table>
									</template>
								</td>
							</tr>
						</template>
					</tbody>
				</table>
			</div>
		</div>

		<p v-if="filteredRows.length === 0 && rows.length > 0" class="mt-2 text-sm shrink-0"
			:class="isDark ? 'text-stone-500' : 'text-stone-600'">
			目前篩選無資料，請切換舞台或日期。
		</p>
		<p v-if="rows.length === 0" class="mt-2 text-amber-500/90 text-sm shrink-0">
			尚未載入流程資料，請確認 data/rundown.csv 可被讀取。
		</p>
	</div>
</template>
