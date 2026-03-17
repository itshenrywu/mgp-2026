/**
 * sync.js - 從 Google Sheet 發佈的 CSV 匯出網址拉取資料，寫入 data/rundown.csv
 * 匯入後在每個舞台第一行加入一筆測試用資料：當天 00:00～11:30，項目與備註為「測試」
 * 使用方式：先將試算表「檔案 → 共用 → 發佈到網路」選 CSV，取得網址或 SHEET_ID
 * 執行：GOOGLE_SHEET_ID=你的試算表ID node sync.js
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = `${__dirname}/data/rundown.csv`;

const SHEET_ID = '1CrVxCB1k3JVgoD_UFYPNsQ_xeKtn23JeszR5XRqtV-E'
const GID = '1543726243'

if (!SHEET_ID) {
  console.error('請設定環境變數 GOOGLE_SHEET_ID（試算表 ID）');
  console.error('例：GOOGLE_SHEET_ID=1abc... node sync.js');
  process.exit(1);
}

const exportUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

/**
 * 在每個舞台的第一筆前插入一筆測試列：當天 00:00 ～ 當天 11:30，項目與備註為「測試」
 * @param {string} csv - 原始 CSV 字串（含標題列）
 * @returns {string} 插入測試列後的 CSV
 */
function insertTestRowPerStage(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return csv;

  const header = lines[0];
  const dataLines = lines.slice(1);

  /** 從「開始時間」欄位取出日期 YYYY-MM-DD */
  const getDate = (line) => {
    const parts = line.split(',');
    const startTime = parts[1] && parts[1].trim();
    if (!startTime) return null;
    return startTime.slice(0, 10);
  };

  const result = [header];
  let lastStage = null;

  for (const line of dataLines) {
    const stage = line.split(',')[0] && line.split(',')[0].trim();
    if (stage && stage !== lastStage) {
      const date = getDate(line);
      if (date) {
        const testRow = `${stage},${date} 00:00:00,${date} 11:30:00,測試,測試`;
        result.push(testRow);
      }
      lastStage = stage;
    }
    result.push(line);
  }

  return result.join('\n');
}

async function sync() {
  try {
    const res = await fetch(exportUrl, {
      headers: { 'User-Agent': 'Node-Sync/1.0' },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const csv = await res.text();
    if (!csv.trim()) {
      throw new Error('取得的內容為空');
    }

    const outDir = dirname(OUT_PATH);
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    const csvWithTest = insertTestRowPerStage(csv);
    writeFileSync(OUT_PATH, csvWithTest, 'utf8');
    const lines = csvWithTest.trim().split('\n').length;
    console.log(`已寫入 ${OUT_PATH}，共 ${lines} 行（已為每個舞台插入測試列）`);
  } catch (err) {
    console.error('同步失敗:', err.message);
    process.exit(1);
  }
}

sync();
