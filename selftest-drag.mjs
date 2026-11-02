/**
 * selftest-drag.mjs —— 用假 DOM 跑 shot.js 的指针状态机，验证「长按后接着拖框」真的出选区。
 *
 * 跑法（本机没有 node/npm，用 Electron 的 node 模式）：
 *   ELECTRON_RUN_AS_NODE=1 "E:/DSH/DeepSeek Harness.exe" selftest-drag.mjs
 *
 * 只验证前端这一半：有没有把正确的 x/y/w/h 发给 /capture。抓屏那半由 capture.ps1 自己保证。
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, 'lib', 'shot.js'), 'utf8')

const W = 1280
const H = 800

// ---------------- 极简 DOM ----------------
let elSeq = 0
const allEls = []

class Style {
  constructor() { this._m = new Map() }
  setProperty(k, v) { this._m.set(k, v) }
  getPropertyValue(k) { return this._m.get(k) || '' }
}
const styleProxy = () => new Proxy(new Style(), {
  get(t, k) {
    if (k in t) return Reflect.get(t, k)
    return t.getPropertyValue(String(k))
  },
  set(t, k, v) { t.setProperty(String(k), v); return true },
})

function makeEl(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    childNodes: [],
    parentNode: null,
    style: styleProxy(),
    _attrs: new Map(),
    _listeners: new Map(),
    __uid: ++elSeq,
    setAttribute(k, v) { this._attrs.set(k, String(v)) },
    getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null },
    removeAttribute(k) { this._attrs.delete(k) },
    hasAttribute(k) { return this._attrs.has(k) },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c },
    insertAdjacentHTML() {},
    removeChild(c) {
      const i = this.childNodes.indexOf(c)
      if (i >= 0) this.childNodes.splice(i, 1)
      c.parentNode = null
      return c
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, [])
      this._listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const a = this._listeners.get(type)
      if (!a) return
      const i = a.indexOf(fn)
      if (i >= 0) a.splice(i, 1)
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    closest() { return null },
    click() {},
    select() {},
  }
  allEls.push(el)
  return el
}

const document = {
  head: makeEl('head'),
  body: makeEl('body'),
  documentElement: makeEl('html'),
  _listeners: new Map(),
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById(id) {
    return allEls.find((e) => e.id === id && e.parentNode) || null
  },
  addEventListener(type, fn, capture) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push({ fn, capture: capture === true })
  },
  removeEventListener(type, fn, capture) {
    const a = this._listeners.get(type)
    if (!a) return
    const i = a.findIndex((r) => r.fn === fn && r.capture === (capture === true))
    if (i >= 0) a.splice(i, 1)
  },
  execCommand() { return true },
}

/** 把一次 DOM 事件按「捕获阶段 → 冒泡阶段」派发给 document 上的监听器 */
function dispatch(type, ev) {
  const records = (document._listeners.get(type) || []).slice()
  const e = Object.assign({
    type,
    button: 0,
    detail: 1,
    isPrimary: true,
    pointerId: 1,
    target: document.body,
    preventDefault() {},
    stopPropagation() {},
  }, ev)
  for (const r of records) r.fn(e)
  return e
}

const captured = []
const window = {
  innerWidth: W,
  innerHeight: H,
  __DSH_LONGPRESS_SHOT__: undefined,
  _listeners: new Map(),
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(fn)
  },
  removeEventListener(type, fn) {
    const a = this._listeners.get(type)
    if (!a) return
    const i = a.indexOf(fn)
    if (i >= 0) a.splice(i, 1)
  },
}

const sandbox = {
  window,
  document,
  navigator: { clipboard: null },
  console,
  setTimeout,
  clearTimeout,
  fetch(url, init) {
    captured.push({ url, body: JSON.parse(init.body) })
    return Promise.resolve({
      json: () => Promise.resolve({
        ok: true, name: 'shot-20260101-000000-000.png',
        file: 'C:/tmp/shot-20260101-000000-000.png',
        width: Math.round(W * (JSON.parse(init.body).w)),
        height: Math.round(H * (JSON.parse(init.body).h)),
        clipboard: true, aspectMismatch: false,
      }),
    })
  },
}
window.document = document
const ctx = createContext(sandbox)
runInContext(SRC, ctx, { filename: 'shot.js' })

// ---------------- 断言 ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`)
  else { fails++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`) }
}
const overlay = () => allEls.find((e) => e.className === '_lps-overlay' && e.parentNode)
const boxEl = () => allEls.find((e) => e.className === '_lps-box' && e.parentNode)

async function scenario() {
  console.log('\n[1] 长按 600ms 触发遮罩')
  dispatch('pointerdown', { clientX: 100, clientY: 100 })
  await sleep(650)
  check('遮罩已创建', !!overlay())
  check('trigger 标记已装', window.__DSH_LONGPRESS_SHOT__ !== undefined)

  console.log('\n[2] 左键不松继续拖到 (300,260) —— 这一步以前永远画不出框')
  dispatch('pointermove', { clientX: 300, clientY: 260 })
  const b = boxEl()
  check('选框已显示', b && b.style.display === 'block', b && ('display=' + b.style.display))
  check('选框 left=100px', b && b.style.left === '100px', b && b.style.left)
  check('选框 top=100px', b && b.style.top === '100px', b && b.style.top)
  check('选框 宽=200px', b && b.style.width === '200px', b && b.style.width)
  check('选框 高=160px', b && b.style.height === '160px', b && b.style.height)

  console.log('\n[3] 松手 → 应该按选区提交，而不是整窗')
  dispatch('pointerup', { clientX: 300, clientY: 260 })
  await sleep(60)
  check('发出了 1 次 capture 请求', captured.length === 1, 'count=' + captured.length)
  const body = captured[0] ? captured[0].body : {}
  const expect = { x: 100 / W, y: 100 / H, w: 200 / W, h: 160 / H }
  for (const k of ['x', 'y', 'w', 'h']) {
    check(`${k} = ${expect[k].toFixed(4)}`,
      Math.abs(body[k] - expect[k]) < 1e-6, 'got ' + body[k])
  }
  check('不再是整窗 (w<1)', body.w < 0.99, 'w=' + body.w)
  check('遮罩已拆除', !overlay())

  console.log('\n[4] 长按后直接松手 → 不应自动抓整窗，应留在遮罩里')
  captured.length = 0
  dispatch('pointerup', {})
  dispatch('pointerdown', { clientX: 400, clientY: 300 })
  await sleep(650)
  check('遮罩再次创建', !!overlay())
  dispatch('pointerup', { clientX: 402, clientY: 301 })
  await sleep(60)
  check('没有发 capture', captured.length === 0, 'count=' + captured.length)
  check('遮罩仍在（等下一次拖动）', !!overlay())

  console.log('\n[5] 遮罩里重新按下并拖框 → 正常出选区')
  dispatch('pointerdown', { clientX: 500, clientY: 400 })
  dispatch('pointermove', { clientX: 700, clientY: 560 })
  dispatch('pointerup', { clientX: 700, clientY: 560 })
  await sleep(60)
  check('发出了 capture', captured.length === 1, 'count=' + captured.length)
  const b2 = captured[0].body
  check('x=500/1280', Math.abs(b2.x - 500 / W) < 1e-6, 'got ' + b2.x)
  check('w=200/1280', Math.abs(b2.w - 200 / W) < 1e-6, 'got ' + b2.w)
  check('h=160/800', Math.abs(b2.h - 160 / H) < 1e-6, 'got ' + b2.h)

  console.log('\n[6] Esc 取消 → 不抓图')
  captured.length = 0
  dispatch('pointerup', {})
  dispatch('pointerdown', { clientX: 100, clientY: 100 })
  await sleep(650)
  check('遮罩在', !!overlay())
  dispatch('keydown', { key: 'Escape' })
  await sleep(60)
  check('Esc 后遮罩拆除', !overlay())
  check('Esc 后没抓图', captured.length === 0, 'count=' + captured.length)

  console.log('\n[7] 可编辑控件里不触发')
  captured.length = 0
  const input = makeEl('input')
  dispatch('pointerdown', { clientX: 50, clientY: 50, target: input })
  await sleep(650)
  check('input 上长按不弹遮罩', !overlay())

  console.log('\n[8] 遮罩里双击 → 整窗；第一次按下不能误判成双击')
  captured.length = 0
  dispatch('pointerdown', { clientX: 200, clientY: 200 })
  await sleep(650)
  check('遮罩在', !!overlay())
  dispatch('pointerup', { clientX: 200, clientY: 200 })   // 触发那笔松手
  await sleep(30)
  dispatch('pointerdown', { clientX: 200, clientY: 200 }) // 遮罩里第 1 下
  check('第 1 下不抓整窗', captured.length === 0, 'count=' + captured.length)
  dispatch('pointerup', { clientX: 200, clientY: 200 })
  await sleep(30)
  dispatch('pointerdown', { clientX: 201, clientY: 200 }) // 遮罩里第 2 下（同一处、够快）
  await sleep(60)
  check('第 2 下 = 双击 → 抓整窗', captured.length === 1, 'count=' + captured.length)
  check('确实是整窗 w=1', captured[0] && captured[0].body.w === 1, captured[0] && String(captured[0].body.w))

  console.log('\n[9] Enter → 整窗')
  captured.length = 0
  await sleep(400)
  dispatch('pointerup', {})
  dispatch('pointerdown', { clientX: 600, clientY: 300 })
  await sleep(650)
  check('遮罩在', !!overlay())
  dispatch('keydown', { key: 'Enter' })
  await sleep(60)
  check('Enter 抓整窗', captured.length === 1 && captured[0].body.w === 1,
    'count=' + captured.length + ' w=' + (captured[0] && captured[0].body.w))
  check('遮罩已拆除', !overlay())

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
  process.exitCode = fails === 0 ? 0 : 1
}

scenario()
