/**
 * dsh-longpress-shot —— 宿主半区
 *
 * 职责：
 *   1) 往桌面端的 index 注入表里推一行内联 script（唯一能在 Electron 桌面端生效的通道），
 *      由页面自己去 <script src="/dsh-longpress-shot/shot.js">，onerror 吞掉，
 *      路由不在时静默失败，宿主永远不会因此起不来。
 *   2) 注册三条路由：
 *        GET  /dsh-longpress-shot/shot.js   浏览器端半区（每次按 mtime 重读，改完硬刷新即生效）
 *        POST /dsh-longpress-shot/capture   {x,y,w,h,clipboard} 比例选区 → 调 capture.ps1 抓窗 → 存 PNG
 *        GET  /dsh-longpress-shot/file      取回刚存的 PNG（前端缩略图预览）
 *   3) web 形态额外用 tapIndex 补一份 script 标签（桌面端走不到这条路，两条并存互不冲突）。
 *
 * 抓屏为什么在宿主做：页面拿不到 OS 级截图能力（getDisplayMedia 会弹选择器），
 * 而宿主插件跑在 Node 里，可以直接起 PowerShell 用 GDI 抓窗口客户区。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.dirname(HERE)

const CAPTURE_PS1_CANDIDATES = [
  path.join(HERE, 'capture.ps1'),
  path.join(PKG_ROOT, 'lib', 'capture.ps1'),
]
const SHOT_JS_CANDIDATES = [
  path.join(HERE, 'shot.js'),
  path.join(PKG_ROOT, 'lib', 'shot.js'),
  path.join(PKG_ROOT, 'assets', 'shot.js'),
]

const SCRIPT_URL = '/dsh-longpress-shot/shot.js'
const VERSION_URL = '/dsh-longpress-shot/version'
const SHOT_DIR = path.join(os.homedir(), '.dsh', 'longpress-shots')
const MAX_BODY = 64 * 1024
const DIAG_MAX = 8 * 1024

/**
 * 桌面端注入行：内联 script（不是 script-src —— 那条加载失败会 reject 掉整个 boot）。
 *
 * 除了加载 shot.js，它还做一件关键的事：每 5s 问一次 /dsh-longpress-shot/version，
 * 发现磁盘上的 shot.js 版本和页面里正在跑的版本不一致就 location.reload()。
 * 打包版桌面端没有 Ctrl+R（菜单里 reload 只在 development 分支里），
 * 没有这一步的话改完 shot.js 永远进不了已经在运行的页面。
 */
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__DSH_LONGPRESS_LOADER__)return;window.__DSH_LONGPRESS_LOADER__=1;' +
  'var S="' + SCRIPT_URL + '",V="' + VERSION_URL + '";' +
  'var s=document.createElement("script");s.src=S+"?v="+Date.now();' +
  's.onerror=function(){};d.appendChild(s);' +
  'var seen=null;' +
  'function pick(t){var m=/__DSH_LONGPRESS_SHOT__\\s*=\\s*\\{[^}]*version:\\s*.([0-9][^\'"]*)./.exec(t);return m?m[1]:null}' +
  'function apply(v){if(!v)return;if(seen===null){seen=v;return}' +
  'if(v!==seen){seen=v;try{location.reload()}catch(e){}}}' +
  'function probe(){fetch(V,{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(j){' +
  'if(j&&j.version){apply(j.version);return null}' +
  'return fetch(S,{cache:"no-store"}).then(function(r){return r.text()}).then(pick).then(apply)' +
  '}).catch(function(){})}' +
  'probe();setInterval(probe,5000)}catch(e){}})()'

function readFresh(candidates, cacheRef) {
  for (const p of candidates) {
    try {
      const st = fs.statSync(p)
      if (cacheRef.value && cacheRef.value.mtimeMs === st.mtimeMs) return cacheRef.value.text
      const text = fs.readFileSync(p, 'utf8')
      cacheRef.value = { text, mtimeMs: st.mtimeMs }
      return text
    } catch { /* 换下一个候选 */ }
  }
  return cacheRef.value ? cacheRef.value.text : ''
}

function findFile(candidates) {
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* miss */ }
  }
  return undefined
}

function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  return m.slice(1).every((s) => Number(s) >= 0 && Number(s) <= 255)
}

/** 顶层窗口抓屏脚本的输出是「一行 JSON」；这里把它解析出来并补上 stderr 上下文 */
function runCapture(args) {
  return new Promise((resolve) => {
    const ps1 = findFile(CAPTURE_PS1_CANDIDATES)
    if (!ps1) {
      resolve({ ok: false, error: 'capture.ps1-not-found', searched: CAPTURE_PS1_CANDIDATES })
      return
    }
    const argv = [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', ps1,
      ...args,
    ]
    let out = ''
    let err = ''
    let child
    try {
      child = spawn('powershell.exe', argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: 'spawn-failed', detail: String(e && e.message) })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      resolve({ ok: false, error: 'timeout' })
    }, 15000)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: 'spawn-error', detail: String(e && e.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || ''
      try {
        const parsed = JSON.parse(line)
        if (!parsed.ok && err.trim()) parsed.stderr = err.trim().slice(0, 800)
        resolve(parsed)
      } catch {
        resolve({ ok: false, error: 'bad-json', code, stdout: out.slice(-800), stderr: err.slice(-800) })
      }
    })
  })
}

function clamp01(v, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

export default {
  name: 'dsh-longpress-shot',

  apply(root) {
    const rowDisposers = []
    root.effect(() => () => {
      for (const d of rowDisposers) { try { d() } catch { /* ignore */ } }
    })

    // ① 桌面端注入行：apply() 第一件事就进表（桌面端的注入表是宿主启动时一次性收集的）
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === SCRIPT_URL) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(SCRIPT_URL)) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
      } catch { /* 注入行失败不能拖垮宿主 */ }
    }))

    // ② 路由：等 webServer 就绪
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      const shotJsCache = { value: null }

      /** 只认回环 + 同源：挡住 DNS 重绑定与跨站 POST */
      function rejected(req, res) {
        const host = String(req.headers.host || '')
        const hostname = host.replace(/:\d+$/, '')
        if (!isLoopbackHostname(hostname)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('forbidden: non-loopback host')
          return true
        }
        if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('forbidden: cross-site')
          return true
        }
        const origin = req.headers.origin
        if (origin) {
          try {
            const o = new URL(String(origin))
            if (o.host !== host) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('forbidden: cross-origin')
              return true
            }
          } catch {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('forbidden: bad origin')
            return true
          }
        }
        return false
      }

      function json(res, code, obj) {
        const body = JSON.stringify(obj)
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(body)
      }

      function route(entry) {
        const inner = entry.handler
        return ctx.webServer.register(Object.assign({}, entry, {
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try { return await inner(req, res) } catch (e) {
              try { json(res, 500, { ok: false, error: 'handler-threw', detail: String(e && e.message) }) } catch { /* 头已发 */ }
            }
          },
        }))
      }

      // —— 浏览器端半区 ——
      disposers.push(route({
        kind: 'exact',
        path: SCRIPT_URL,
        handler: (req, res) => {
          const text = readFresh(SHOT_JS_CANDIDATES, shotJsCache)
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(text)
        },
      }))

      // —— 版本探针：页面靠它发现 shot.js 变了，然后自己 reload ——
      disposers.push(route({
        kind: 'exact',
        path: VERSION_URL,
        handler: (req, res) => {
          const text = readFresh(SHOT_JS_CANDIDATES, shotJsCache)
          const m = /__DSH_LONGPRESS_SHOT__\s*=\s*\{[^}]*version:\s*'([^']+)'/.exec(text)
          json(res, 200, {
            ok: true,
            version: m ? m[1] : '',
            bytes: Buffer.byteLength(text),
          })
        },
      }))

      // —— 诊断日志：页面把 innerWidth/dpr/rect 打上来，落到 diag.jsonl ——
      disposers.push(route({
        kind: 'exact',
        path: '/dsh-longpress-shot/log',
        handler: (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
          let body = ''
          let killed = false
          req.on('data', (c) => {
            body += c
            if (body.length > DIAG_MAX) { killed = true; req.destroy() }
          })
          req.on('end', () => {
            if (!killed) {
              try {
                fs.mkdirSync(SHOT_DIR, { recursive: true })
                const line = body.replace(/[\r\n]+/g, ' ').slice(0, DIAG_MAX)
                fs.appendFileSync(path.join(SHOT_DIR, 'diag.jsonl'), line + '\n')
              } catch { /* 诊断失败不影响主流程 */ }
            }
            json(res, 200, { ok: true })
          })
        },
      }))

      // —— 抓屏 ——
      disposers.push(route({
        kind: 'exact',
        path: '/dsh-longpress-shot/capture',
        handler: (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
          let body = ''
          let tooBig = false
          req.on('data', (chunk) => {
            body += chunk
            if (body.length > MAX_BODY) { tooBig = true; req.destroy() }
          })
          req.on('end', async () => {
            if (tooBig) { json(res, 413, { ok: false, error: 'body-too-large' }); return }
            let payload = {}
            try { payload = body ? JSON.parse(body) : {} } catch { payload = {} }

            const x = clamp01(payload.x, 0)
            const y = clamp01(payload.y, 0)
            const w = clamp01(payload.w, 1)
            const h = clamp01(payload.h, 1)
            const clipboard = payload.clipboard === false ? 0 : 1
            const vpAspect = Number(payload.aspect)

            const outFile = path.join(SHOT_DIR, `shot-${stamp()}.png`)
            const result = await runCapture([
              '-OutFile', outFile,
              '-AncestorPid', String(process.pid),
              '-CropX', x.toFixed(6),
              '-CropY', y.toFixed(6),
              '-CropW', Math.max(w, 0.001).toFixed(6),
              '-CropH', Math.max(h, 0.001).toFixed(6),
              '-Clipboard', String(clipboard),
            ])

            if (!result || !result.ok) { json(res, 200, Object.assign({ ok: false }, result)); return }

            // 视口宽高比与窗口客户区宽高比应当一致；不一致说明抓到的是别的窗口
            let aspectMismatch = false
            if (Number.isFinite(vpAspect) && vpAspect > 0 && result.clientW && result.clientH) {
              const ratio = result.clientW / result.clientH
              aspectMismatch = Math.abs(ratio - vpAspect) / vpAspect > 0.08
            }

            json(res, 200, {
              ok: true,
              file: result.file,
              name: path.basename(result.file || ''),
              width: result.width,
              height: result.height,
              bytes: result.bytes,
              clientW: result.clientW,
              clientH: result.clientH,
              clipboard: result.clipboard === true,
              title: result.title,
              aspectMismatch,
            })
          })
          return
        },
      }))

      // —— 取回图片（前端缩略图） ——
      disposers.push(route({
        kind: 'exact',
        path: '/dsh-longpress-shot/file',
        handler: (req, res) => {
          let name = ''
          try { name = new URL(req.url || '/', 'http://x').searchParams.get('name') || '' } catch { name = '' }
          const base = path.basename(name)
          if (!base || base !== name || !/^shot-[0-9]{8}-[0-9]{6}-[0-9]{3}\.png$/.test(base)) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('bad name')
            return
          }
          const full = path.join(SHOT_DIR, base)
          let buf
          try { buf = fs.readFileSync(full) } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Content-Length': buf.length,
          })
          res.end(buf)
        },
      }))

      // web 形态的补偿通道（桌面端这条不生效，由 ① 负责）
      if (typeof ctx.webServer.tapIndex === 'function') {
        disposers.push(ctx.webServer.tapIndex((html) => {
          if (html.includes(SCRIPT_URL)) return html
          const tag = `<script defer src="${SCRIPT_URL}"></script>`
          if (html.includes('</body>')) return html.replace('</body>', tag + '</body>')
          return html + tag
        }))
      }

      ctx.effect(() => () => {
        for (const d of disposers) { try { d() } catch { /* ignore */ } }
      })

      try {
        fs.mkdirSync(SHOT_DIR, { recursive: true })
      } catch { /* 目录不可建时抓屏会自己报错 */ }
    })
  },
}
