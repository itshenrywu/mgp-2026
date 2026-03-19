import { execFile } from 'child_process'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import express from 'express'
import cors from 'cors'

const execFileAsync = promisify(execFile)

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
	const escapedPath = String(filePath).replace(/'/g, "''")
	const command = [
		"$ErrorActionPreference = 'Stop'",
		"$shell = New-Object -ComObject Shell.Application",
		`$targetPath = '${escapedPath}'`,
		'$folderPath = [System.IO.Path]::GetDirectoryName($targetPath)',
		'$fileName = [System.IO.Path]::GetFileName($targetPath)',
		'if ([string]::IsNullOrWhiteSpace($folderPath) -or [string]::IsNullOrWhiteSpace($fileName)) { throw "無效檔案路徑" }',
		'$folder = $shell.Namespace($folderPath)',
		'if ($null -eq $folder) { throw "找不到資料夾" }',
		'$file = $folder.ParseName($fileName)',
		'if ($null -eq $file) { throw "找不到檔案" }',
		'$duration = $folder.GetDetailsOf($file, 27)',
		'Write-Output $duration',
	].join('; ')

	const { stdout } = await execFileAsync('powershell', [
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-Command',
		command,
	])

	const durationText = String(stdout).trim()
	const normalized = durationText.replace(/[^\d:.,]/g, '').replace(',', '.')
	if (!normalized) {
		throw new Error('PowerShell 回傳空白長度')
	}

	const durationParts = normalized.split(':').filter(Boolean).map((part) => Number.parseFloat(part))
	if (durationParts.some((part) => !Number.isFinite(part))) {
		throw new Error(`PowerShell 回傳無效長度格式: ${durationText}`)
	}

	let duration = 0
	if (durationParts.length === 3) {
		duration = durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2]
	} else if (durationParts.length === 2) {
		duration = durationParts[0] * 60 + durationParts[1]
	} else if (durationParts.length === 1) {
		duration = durationParts[0]
	} else {
		throw new Error(`PowerShell 回傳無效長度格式: ${durationText}`)
	}

	if (!Number.isFinite(duration)) {
		throw new Error(`PowerShell 回傳無效秒數: ${durationText}`)
	}
	return duration
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