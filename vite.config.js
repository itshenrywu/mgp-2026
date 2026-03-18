import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
	plugins: [vue()],
	server: {
		proxy: {
			// 開發時將 /ws WebSocket 請求轉發到 Express server
			'/ws': {
				target:          'ws://localhost:3333',
				ws:              true,
				rewriteWsOrigin: true,
			},
			// 開發時的廣播測試頁也可直接用 localhost:5173/test 開啟
			'/test':      'http://localhost:3333',
			'/broadcast': 'http://localhost:3333',
			'/status':    'http://localhost:3333',
		},
	},
})
