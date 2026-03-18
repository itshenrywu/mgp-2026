<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import csvContent from '../data/rundown.csv?raw'

// ── WebSocket 同步 ─────────────────────────────────────────────────────────
const WS_URL = `ws://${window.location.host}/ws`
const pgmName = ref('')        // 目前 PGM 的「備註」欄位名稱
const pvwName = ref('')        // 目前 PVW 的「備註」欄位名稱
const pgmSceneType = ref('')   // 目前 PGM 的 scene_type（如 'list'）
const pgmListStartedSec = ref(0)  // WS 送來的 started（已播秒數）
const pgmListStartedAt = ref(0)   // 收到 WS 訊息的時間戳（Date.now()）
const wsConnected = ref(false)
let ws = null
let wsReconnectTimer = null

function connectWS() {
	if (ws) {
		ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
		try { ws.close() } catch (_) { }
	}
	ws = new WebSocket(WS_URL)

	ws.onopen = () => {
		wsConnected.value = true
	}

	ws.onmessage = (e) => {
		let msg
		try { msg = JSON.parse(e.data) } catch { return }
		const { type, name } = msg
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
		} else if (type === 'clear') {
			pgmName.value = ''
			pvwName.value = ''
			pgmSceneType.value = ''
			pgmListStartedSec.value = 0
			pgmListStartedAt.value = 0
		}
	}

	ws.onclose = () => {
		wsConnected.value = false
		wsReconnectTimer = setTimeout(connectWS, 3000)
	}

	ws.onerror = () => {
		try { ws.close() } catch (_) { }
	}
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
	return `${minutes} 分 ${seconds} 秒`
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
onMounted(() => {
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
	ticker = setInterval(() => {
		now.value = new Date()
	}, 1000)
	document.addEventListener('click', onDocumentClick)
	connectWS()
})
onUnmounted(() => {
	if (ticker) clearInterval(ticker)
	if (wsReconnectTimer) clearTimeout(wsReconnectTimer)
	if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close() } catch (_) { } }
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

// 預設選第一個舞台與第一個日期（空字串＝全部）
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

function getTagId(text) {
	// 取最前面的 1_2 或 2_1
	const match = text.match(/^(\d+)_(\d+)/)
	if (match) {
		return match[1] + '_' + match[2]
	}
	return text
}

// 判斷該列的 項目 欄位是否含有 [List] 標籤
function hasListTag(row) {
	const segments = parseItemWithTags(row['項目'] || '')
	return segments.some(
		(seg) => seg.type === 'tag' && (seg.text === 'List' || seg.text.startsWith('List'))
	)
}

// List 子表格靜態資料：key 為備註欄的 tag id，value 為 {cue, duration} 陣列
// 資料是假的，到時候是直接拉 vmix
const listData = {
	'2_1': [
		{ cue: '尾一 > 大港CF', duration: 60 },
		{ cue: '中插1-4', duration: 120 },
		{ cue: '媒體素材1', duration: 300 },
		{ cue: '中插 5-8', duration: 120 },
		{ cue: '節目表(早)*2 > 媒體素材1 > 節目表(早) > 媒體素材1 > 節目表(早)*2', duration: 2100 },
		{ cue: '中插1-4', duration: 120 },
		{ cue: '媒體素材1', duration: 300 },
		{ cue: '中插 5-8', duration: 120 },
		{ cue: '麥當勞 包框', duration: 180 },
		{ cue: '尾一', duration: 30 },
	],
}

// 依備註欄 tag id 取得 List 子表格資料
function getListItems(row) {
	const id = getTagId(row['備註'] || '')
	return listData[id] ?? []
}

// 判斷該列是否為目前播放中的 PGM list
function isPgmListRow(row) {
	return pgmSceneType.value === 'list'
		&& !!pgmName.value
		&& getTagId(row['備註'] || '') === getTagId(pgmName.value)
}

// 目前 PGM list 已播秒數（每秒隨 now 更新）
// elapsed = started（WS 送來的基準值）+ 收到後累計的秒數
const pgmListElapsed = computed(() => {
	if (pgmSceneType.value !== 'list' || !pgmListStartedAt.value) return null
	return Math.max(0, pgmListStartedSec.value + (now.value.getTime() - pgmListStartedAt.value) / 1000)
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
		<!-- WebSocket 連線狀態指示 -->
		<div class="fixed top-4 right-[8.5rem] z-20 flex items-center gap-1.5 text-xs"
			:class="isDark ? 'text-stone-400' : 'text-stone-600'"
			:title="wsConnected ? 'WebSocket 已連線' : 'WebSocket 未連線，嘗試重連中…'">
			<span class="w-2 h-2 rounded-full shrink-0"
				:class="wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-stone-500'"></span>
			<span class="hidden sm:inline">{{ wsConnected ? '已連線' : '未連線' }}</span>
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
							<option value="">全部</option>
							<option v-for="d in dateOptions" :key="d" :value="d">{{ d }}</option>
						</select>
					</div>
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
				<div class="text-sm mb-1t text-stone-400">
					<span class="font-semibold text-emerald-500">準時</span> /
					<span class="font-medium text-stone-400">超前</span> /
					<span class="font-medium text-stone-400">落後</span>
				</div>
				<div class="inline-block font-mono text-4xl tracking-wider tabular-nums"
					:class="isDark ? 'text-stone-200' : 'text-stone-800'">
					--:--
				</div>
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
							<th class="w-[20rem] py-2.5 px-4 text-left">時間</th>
							<th class="w-[5rem] min-w-[6rem] py-2.5 px-2 text-center">表定流程</th>
							<th class="w-[5rem] py-2.5 px-2 text-center">vMix</th>
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
									{{ getDuration(row['開始時間'], row['結束時間']) }}
								</td>
								<td class="py-2.5 px-2 align-middle text-center text-sm"
									:class="isDark ? 'text-stone-400' : 'text-stone-600'">
									<template v-if="getRowTimeStatus(row) === 'current' && getTimeLeftUntilEnd(row)">
										<span class="font-mono font-medium"
											:class="isDark ? 'text-stone-100' : 'text-stone-800'">
											{{ getTimeLeftUntilEnd(row) }}<br>
											<span class="text-xs">後結束</span>
										</span>
									</template>
									<template v-else-if="i === nextRowIndex && getTimeUntilStart(row)">
										<span class="font-mono font-medium"
											:class="isDark ? 'text-stone-500' : 'text-stone-400'">
											{{ getTimeUntilStart(row) }}<br>
											<span class="text-xs">後開始</span>
										</span>
									</template>
								</td>
								<td class="py-2.5 px-2 align-middle text-center">
									<span v-if="pgmName && getTagId(row['備註']) === getTagId(pgmName)"
										class="font-bold text-sm tracking-widest"
										:class="isDark ? 'text-red-400' : 'text-red-600'">PGM</span>
									<span v-if="pvwName && getTagId(row['備註']) === getTagId(pvwName)"
										class="font-bold text-sm tracking-widest"
										:class="isDark ? 'text-emerald-400' : 'text-emerald-600'">PVW</span>
								</td>
							</tr>
							<!-- List 子列：當 Tag == List 時顯示 -->
							<tr v-if="hasListTag(row)" class="border-b"
								:class="isDark ? 'border-stone-700/60' : 'border-stone-400'">
								<td></td>
								<td colspan="3" class="pb-4 px-3">

									<!-- 使用 v-for 單元素陣列技巧，將 summary/currentIdx/cueProgress 作為模板區域變數，避免重複計算 -->
									<template v-for="[summary, currentIdx, cueProgress] in [[getListSummary(row), getListCurrentCueIdx(row), getListCurrentCueProgress(row)]]" :key="'list-meta'">
										<div class="font-bold text-sm tracking-widest text-right mb-1">
											<template v-if="summary">
												已播
												<span class="font-mono tabular-nums">{{ summary.elapsed }}</span>
												／
												<span class="font-mono tabular-nums">{{ summary.remaining }}</span>
												後結束
											</template>
											<template v-else>
												<span :class="isDark ? 'text-stone-600' : 'text-stone-400'">--:-- / --:--</span>
											</template>
										</div>
										<table class="w-full text-xs border-collapse rounded-lg overflow-hidden"
											:class="isDark ? 'border border-stone-600/50' : 'border border-stone-400/60'">
											<thead>
												<tr
													:class="isDark ? 'bg-stone-700/60 text-stone-300 border-b border-stone-600/50' : 'bg-stone-300/80 text-stone-700 border-b border-stone-400/60'">
													<th class="text-left px-3 py-1 font-semibold w-2"></th>
													<th class="text-left px-3 py-1 font-semibold">cue</th>
													<th class="text-right px-3 py-1 font-semibold w-24">長度</th>
												</tr>
											</thead>
											<tbody>
												<template v-for="(item, j) in getListItems(row)" :key="j">
													<tr v-if="item !== null" class="border-b" :class="[
														j === currentIdx
															? isDark ? 'bg-amber-500/20 border-amber-500/40' : 'bg-amber-100/80 border-amber-400/50'
															: isDark ? 'bg-stone-800/60 border-stone-600/30' : 'bg-stone-100/90 border-stone-400/30'
													]">
														<td class="px-3 py-1 text-amber-400 font-bold">{{ j === currentIdx ? '▶' : '' }}</td>
														<td class="px-3 py-1" :class="j === currentIdx ? (isDark ? 'text-amber-200 font-semibold' : 'text-amber-800 font-semibold') : ''">
															{{ item.cue }}
															<!-- 目前 cue：顯示已播 / 剩餘 -->
															<span v-if="j === currentIdx && cueProgress"
																class="block mt-0.5 font-mono font-normal tabular-nums"
																:class="isDark ? 'text-amber-400/80' : 'text-amber-700'">
																已播 {{ cueProgress.elapsed }} ／ {{ cueProgress.remaining }} 後結束
															</span>
														</td>
														<td class="px-3 py-1 text-right tabular-nums font-mono"
															:class="isDark ? 'text-stone-300' : 'text-stone-600'">{{
																formatListDuration(item.duration) }}</td>
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
