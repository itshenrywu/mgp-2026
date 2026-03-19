import { createRequire } from 'node:module'
import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import express from 'express'
import cors from 'cors'
import mediaInfoFactory from 'mediainfo.js'

const require = createRequire(import.meta.url)
const MEDIAINFO_WASM = require.resolve('mediainfo.js/MediaInfoModule.wasm')

/** 單例：MediaInfo WASM 不應並行 analyzeData，以佇列序列化 */
let mediaInfoInstancePromise = null
let analyzeQueue = Promise.resolve()

function enqueueAnalyze(task) {
	const run = analyzeQueue.then(task)
	analyzeQueue = run.catch(() => {})
	return run
}

function getMediaInfoInstance() {
	if (!mediaInfoInstancePromise) {
		mediaInfoInstancePromise = mediaInfoFactory({
			locateFile: (filename) =>
				filename === 'MediaInfoModule.wasm' ? MEDIAINFO_WASM : filename,
		})
	}
	return mediaInfoInstancePromise
}

function durationFromMediaInfoResult(result) {
	const tracks = result?.media?.track
	if (!Array.isArray(tracks) || tracks.length === 0) {
		throw new Error('MediaInfo 無法解析媒體資訊')
	}
	const general = tracks.find((t) => t['@type'] === 'General')
	const duration = general?.Duration
	if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
		throw new Error('MediaInfo 無法取得有效長度')
	}
	return duration
}

const BASE_DIR = 'C:\\MGPT\\大港素材整理'

const day1 = [
	{ pre: '1-5南霸天', min: 1, max: 5 },
	{ pre: '2-5女神龍', min: 1, max: 6 },
]

const day2 = [
	{ pre: '1-5南霸天', min: 6, max: 10 },
	{ pre: '2-5女神龍', min: 7, max: 12 },
]

const dayMappings = {
	'1': day1,
	'2': day2,
}

const stageNameMappings = {
	'1': '南霸天',
	'2': '女神龍',
}

function getFileNameWithoutExtension(filePath) {
	const fileName = String(filePath).split(/[\\/]/).pop() ?? ''
	const extIndex = fileName.lastIndexOf('.')
	return extIndex > 0 ? fileName.slice(0, extIndex) : fileName
}

export function getMediaLoungePaths(day = '1', stage) {
	const target = dayMappings[day]
	if (!target) {
		throw new Error(`不支援的 day 參數: ${day}`)
	}
	if (!stageNameMappings[stage]) {
		throw new Error(`不支援的 stage 參數: ${stage}`)
	}

	const filteredTarget = target.filter((item) => item.pre.includes(stageNameMappings[stage]))

	return filteredTarget.flatMap((item) => {
		const paths = []
		for (let i = item.min; i <= item.max; i++) {
			paths.push(`${BASE_DIR}\\${item.pre}_Media Lounge_檔案存放區\\ML${i}\\ML${i}.mp4`)
		}
		return paths
	})
}

export async function probeDurationSeconds(filePath) {
	return enqueueAnalyze(async () => {
		const mediainfo = await getMediaInfoInstance()
		let fh
		try {
			fh = await open(String(filePath), 'r')
		} catch (err) {
			const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
			if (code === 'ENOENT') {
				throw new Error(`找不到檔案: ${filePath}`)
			}
			throw err instanceof Error ? err : new Error(String(err))
		}
		try {
			const { size } = await fh.stat()
			if (size <= 0) {
				throw new Error('檔案為空或無效')
			}
			const readChunk = async (chunkSize, offset) => {
				const buf = new Uint8Array(chunkSize)
				const { bytesRead } = await fh.read(buf, 0, chunkSize, offset)
				return bytesRead === buf.byteLength ? buf : buf.subarray(0, bytesRead)
			}
			const result = await mediainfo.analyzeData(size, readChunk)
			return durationFromMediaInfoResult(result)
		} finally {
			await fh.close()
		}
	})
}

export async function getMediaLoungeDurations(day = '1', stage) {
	const paths = getMediaLoungePaths(day, stage)
	const resultList = await Promise.all(
		paths.map(async (filePath) => {
			try {
				const durationSeconds = await probeDurationSeconds(filePath)
				return {
					filePath,
					durationSeconds: Number(durationSeconds.toFixed(3)),
					ok: true,
				}
			} catch (error) {
				return {
					filePath,
					durationSeconds: null,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}
			}
		})
	)
	const results = Object.fromEntries(
		resultList.map((item) => [getFileNameWithoutExtension(item.filePath), item])
	)

	return {
		day,
		stage,
		total: resultList.length,
		success: resultList.filter((item) => item.ok).length,
		results,
	}
}

export function createMlServer() {
	const app = express()
	app.use(cors())
	app.use(express.json())

	// GET /media-lounge/durations?day=1|2&stage=1|2
	app.get('/media-lounge/durations', async (req, res) => {
		const day = String(req.query.day ?? '1')
		const stage = req.query.stage == null ? null : String(req.query.stage)
		if (!['1', '2'].includes(day)) {
			return res.status(400).json({ ok: false, error: "day 只支援 '1' 或 '2'" })
		}
		if (stage == null) {
			return res.status(400).json({ ok: false, error: "stage 為必填，且只支援 '1' 或 '2'" })
		}
		if (!['1', '2'].includes(stage)) {
			return res.status(400).json({ ok: false, error: "stage 只支援 '1' 或 '2'" })
		}

		try {
			const data = await getMediaLoungeDurations(day, stage)
			res.json({ ok: true, ...data })
		} catch (error) {
			res.status(500).json({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	})

	return app
}

export function startMlServer(port = Number(process.env.ML_PORT) || 3334) {
	const app = createMlServer()
	return app.listen(port, () => {
		console.log(`查詢路徑：      http://localhost:${port}/media-lounge/durations?day=1&stage=1`)
	})
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
	startMlServer()
}