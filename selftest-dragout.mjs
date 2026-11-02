/**
 * selftest-dragout.mjs —— 校验「把预览卡里的图片拖进对话框」这条通路
 *
 * 宿主（@deepseek-ai/dsh-client-ui-attachment 的 installDocumentDropEvents）收附件的
 * 判定是 `dataTransfer.types.includes("Files")`，所以：
 *   1) <img> 的 draggable 必须是 true，且 CSS 里不能有 -webkit-user-drag:none
 *   2) dragstart 时 dataTransfer.items 里必须真的多出一个 File（type=image/png）
 *   3) 字节还没备好时要退化成 text/uri-list，不能拖了个空气
 *   4) 拖拽事件不能被 onShield 截断（否则宿主的 document 监听收不到 drop）
 *
 * 跑：ELECTRON_RUN_AS_NODE=1 "E:/DSH/DeepSeek Harness.exe" selftest-dragout.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, 'lib', 'shot.js'), 'utf8')

const W = 1280
const H = 800
const WHALE = { left: W - 250, top: H - 250, right: W, bottom: H }
const SHOT_NAME = 'shot-20260101-000000-000.png'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')) }
}

// ---------------- 极简 DOM ----------------
function classSet() {
  const s = new Set()
  return {
    add(c) { s.add(String(c)) },
    remove(c) { s.delete(String(c)) },
    contains(c) { return s.has(String(c)) },
    _set: s,
  }
}

function makeEl(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    textContent: '',
    title: '',
    alt: '',
    src: '',
    childNodes: [],
    parentNode: null,
    style: {},
    _attrs: new Map(),
    _listeners: new Map(),
    _rect: null,
    _className: '',
    draggable: false,
    classList: classSet(),
    setAttribute(k, v) {
      this._attrs.set(String(k), String(v))
      if (String(k).toLowerCase() === 'draggable') this.draggable = String(v) === 'true'
    },
    getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null },
    hasAttribute(k) { return this._attrs.has(k) },
    removeAttribute(k) { this._attrs.delete(String(k)) },
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c },
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
    removeEventListener() {},
    setPointerCapture() { this._captured = true },
    releasePointerCapture() { this._captured = false },
    click() {},
    select() {},
    getBoundingClientRect() { return elRect(this) },
    closest(sel) { return closestOf(this, sel) },
  }
  Object.defineProperty(el, 'className', {
    get() { return el._className },
    set(v) {
      el._className = String(v)
      el.classList._set.clear()
      String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList._set.add(c))
    },
  })
  return el
}

function elRect(el) {
  if (el._rect) return el._rect
  const isCard = el.classList && el.classList.contains('_lps-card')
  const w = isCard ? 340 : 0
  const h = isCard ? 240 : 0
  const left = parseFloat(el.style.left) || 0
  const top = parseFloat(el.style.top) || 0
  return { left, top, width: w, height: h, right: left + w, bottom: top + h }
}

function matches(el, sel) {
  if (!el || !el.classList) return false
  if (sel === '._lps-card') return el.classList.contains('_lps-card')
  if (sel === '._lps-toast') return el.classList.contains('_lps-toast')
  if (sel === '[data-act]') return el.hasAttribute('data-act')
  if (sel === '._lps-card header') {
    if (el.tagName !== 'HEADER') return false
    return !!closestOf(el.parentNode, '._lps-card')
  }
  return false
}

function closestOf(el, sel) {
  let cur = el
  while (cur) {
    if (matches(cur, sel)) return cur
    cur = cur.parentNode
  }
  return null
}

const whaleEl = makeEl('div')
whaleEl.className = 'dshwv-root'
whaleEl._rect = WHALE

const body = makeEl('body')

const styleTags = []
const document = {
  head: makeEl('head'),
  body,
  documentElement: makeEl('html'),
  _listeners: new Map(),
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById(id) {
    for (const tag of styleTags) if (tag.id === id) return tag
    return null
  },
  querySelector(sel) { return sel === '.dshwv-root' ? whaleEl : null },
  addEventListener(type, fn, capture) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push({ fn, capture: capture === true })
  },
  removeEventListener() {},
  execCommand() { return true },
}
// <style> 创建时要能被 getElementById 找到（ensureStyle 的幂等判断）
const origCreate = document.createElement
document.createElement = function (tag) {
  const el = origCreate(tag)
  if (String(tag).toLowerCase() === 'style') {
    styleTags.push(el)
    Object.defineProperty(el, 'id', {
      get() { return el._attrs.get('id') || '' },
      set(v) { el._attrs.set('id', String(v)) },
    })
  }
  return el
}

const store = new Map()
const window = {
  innerWidth: W,
  innerHeight: H,
  location: { origin: 'http://127.0.0.1:63342' },
  __DSH_LONGPRESS_SHOT__: undefined,
  localStorage: {
    getItem(k) { return store.has(k) ? store.get(k) : null },
    setItem(k, v) { store.set(k, String(v)) },
    removeItem(k) { store.delete(k) },
  },
  _listeners: new Map(),
  addEventListener(type, fn, capture) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push({ fn, capture: capture === true })
  },
  removeEventListener() {},
}
window.document = document

// ---------------- File / Blob 桩 ----------------
class FakeBlob {
  constructor(parts, opts) {
    this._parts = parts || []
    this.type = (opts && opts.type) || ''
    this.size = 0
    for (const p of this._parts) {
      // 真 Blob 可由「其他 Blob + 字节串」组成，size 要连内层的 size 一起算
      if (p instanceof FakeBlob) this.size += p.size
      else this.size += (p && p.length) || 0
    }
  }
}
class FakeFile extends FakeBlob {
  constructor(parts, name, opts) {
    super(parts, opts)
    this.name = String(name)
  }
}

// ---------------- dataTransfer 桩 ----------------
function makeDataTransfer() {
  const map = new Map()
  const items = []
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    types: [],
    items: {
      add(f) {
        items.push(f)
        if (!this.owner.types.includes('Files')) this.owner.types.push('Files')
      },
      get length() { return items.length },
      owner: null,
    },
    files: items,
    setData(k, v) {
      map.set(String(k), String(v))
      if (!this.types.includes(String(k))) this.types.push(String(k))
    },
    getData(k) { return map.has(String(k)) ? map.get(String(k)) : '' },
    _items: items,
    _map: map,
  }
}

const fetchLog = []
const sandbox = {
  window,
  document,
  navigator: { clipboard: null },
  console,
  setTimeout,
  clearTimeout,
  Date,
  localStorage: window.localStorage,
  File: FakeFile,
  Blob: FakeBlob,
  fetch(url, init) {
    fetchLog.push({ url, init })
    if (url.indexOf('/file?') >= 0) {
      return Promise.resolve({
        blob: () => Promise.resolve(new FakeBlob([PNG_BYTES], { type: 'image/png' })),
        json: () => Promise.resolve({ ok: false }),
      })
    }
    return Promise.resolve({
      json: () => Promise.resolve({
        ok: true,
        name: SHOT_NAME,
        file: 'C:/tmp/' + SHOT_NAME,
        width: 200, height: 160, clipboard: false, aspectMismatch: false,
      }),
    })
  },
}
sandbox.window.localStorage = window.localStorage

const ctx = createContext(sandbox)
runInContext(SRC, ctx, { filename: 'shot.js' })

function fire(type, ev) {
  let stoppedAt = null
  const e = Object.assign({
    type,
    button: 0,
    pointerId: 1,
    isPrimary: true,
    clientX: 0,
    clientY: 0,
    target: body,
    preventDefault() {},
    stopPropagation() { if (!stoppedAt) stoppedAt = 'propagation' },
    stopImmediatePropagation() { if (!stoppedAt) stoppedAt = 'immediate' },
  }, ev)
  const wl = (window._listeners.get(type) || []).filter((r) => r.capture)
  for (const r of wl) {
    r.fn(e)
    if (stoppedAt) return { e, stoppedAt, reachedDocument: false }
  }
  const dl = (document._listeners.get(type) || []).filter((r) => r.capture)
  for (const r of dl) {
    r.fn(e)
    if (stoppedAt) return { e, stoppedAt, reachedDocument: true }
  }
  return { e, stoppedAt, reachedDocument: true }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cardEl = () => body.childNodes.find((n) => n.classList && n.classList.contains('_lps-card')) || null
const imgEl = () => {
  const c = cardEl()
  return c ? (function walk(n) { if (!n) return null; if (n.tagName === 'IMG') return n; for (const k of n.childNodes || []) { const r = walk(k); if (r) return r } return null })(c) : null
}
// v1.10.0：拖源是卡片里的 div._lps-drag，不是 img
const dragSrcEl = () => {
  const c = cardEl()
  return c ? (function walk(n) {
    if (!n) return null
    if (n.classList && n.classList.contains('_lps-drag')) return n
    for (const k of n.childNodes || []) { const r = walk(k); if (r) return r }
    return null
  })(c) : null
}

async function grabCard() {
  fire('pointerdown', { clientX: 100, clientY: 100 })
  await sleep(650)
  fire('pointermove', { clientX: 300, clientY: 260 })
  fire('pointerup', { clientX: 300, clientY: 260 })
  await sleep(120)
  return cardEl()
}
async function scenario() {
  console.log('\n[1] 抓一张，弹出预览卡')
  const card = await grabCard()
  ok('预览卡已创建', !!card)
  if (!card) { report(); return }

  console.log('\n[2] 拖源必须是 div._lps-drag，img 不再自己可拖')
  const drag2 = dragSrcEl()
  const img = imgEl()
  ok('有 div._lps-drag', !!drag2)
  ok('拖源 draggable="true"', !!drag2 && drag2.getAttribute('draggable') === 'true',
    drag2 && String(drag2.getAttribute('draggable')))
  ok('拖源挂了 dragstart 监听', !!drag2 && (drag2._listeners.get('dragstart') || []).length > 0,
    drag2 ? 'n=' + (drag2._listeners.get('dragstart') || []).length : '(no drag src)')
  ok('拖源 title 提示可以拖进输入框', !!drag2 && /拖到输入框/.test(drag2.title), drag2 && drag2.title)
  ok('img draggable="false"', !!img && img.getAttribute('draggable') === 'false',
    img && String(img.getAttribute('draggable')))
  ok('img 没有被挂 dragstart', !!img && (img._listeners.get('dragstart') || []).length === 0,
    img ? 'n=' + (img._listeners.get('dragstart') || []).length : '(no img)')

  console.log('\n[3] CSS：img 关掉原生拖拽，拖源给 grab 光标')
  const cssText = styleTags.map((s) => s.textContent).join('\n')
  ok('img 的 CSS 含 -webkit-user-drag:none，且 pointer-events:none',
    /\._lps-card img\{[^}]*-webkit-user-drag:none[^}]*pointer-events:none/.test(cssText))
  ok('拖源 CSS 给了 cursor:grab', /\._lps-drag\{[^}]*cursor:grab/.test(cssText))

  console.log('\n[4] 字节预取：卡片一出现就去拿 /file')
  const fileReq = fetchLog.filter((r) => r.url.indexOf('/file?') >= 0)
  ok('发过一次 /file 预取', fileReq.length === 1, 'n=' + fileReq.length)
  ok('预取带了正确的 name', fileReq.length === 1 && fileReq[0].url.indexOf(encodeURIComponent(SHOT_NAME)) >= 0,
    fileReq.length ? fileReq[0].url : '(none)')

  console.log('\n[5] dragstart 往 dataTransfer 里塞 File（宿主只看 types 里的 Files）')
  const dt = makeDataTransfer()
  dt.items.owner = dt
  drag2._listeners.get('dragstart')[0]({ type: 'dragstart', target: drag2, dataTransfer: dt, preventDefault() {} })
  ok('types 里有 Files', dt.types.indexOf('Files') >= 0, JSON.stringify(dt.types))
  ok('items 里多了一个文件', dt._items.length === 1, 'n=' + dt._items.length)
  const f = dt._items[0]
  ok('文件名就是截图名', !!f && f.name === SHOT_NAME, f && f.name)
  ok('MIME 是 image/png', !!f && f.type === 'image/png', f && f.type)
  ok('字节数非空', !!f && f.size === PNG_BYTES.length, f && String(f.size))
  ok('effectAllowed = copy', dt.effectAllowed === 'copy', dt.effectAllowed)
  // v1.10.0：DownloadURL / text/uri-list 都必须缺席，否则 Chromium 会用虚拟 file.png 顶掉真实 File
  ok('没有 DownloadURL', dt.types.indexOf('DownloadURL') < 0, JSON.stringify(dt.types))
  ok('没有 text/uri-list', dt.types.indexOf('text/uri-list') < 0, JSON.stringify(dt.types))
  ok('text/plain 也缺席（只留 Files 一项）', dt.types.indexOf('text/plain') < 0, JSON.stringify(dt.types))

  console.log('\n[6] 拖拽事件不被 onShield 截断（否则宿主收不到 drop）')
  const imgRect = elRect(card)
  for (const t of ['dragstart', 'dragover', 'drop', 'dragend']) {
    const r = fire(t, { clientX: imgRect.left + 100, clientY: imgRect.top + 120, target: drag2 })
    ok(t + ' 未被截断', r.stoppedAt === null, 'stoppedAt=' + r.stoppedAt)
  }
  // 反向：卡片上的 pointer 事件仍然要被截断（v1.4.0 的鲸鱼隔离不能回退）
  const pr = fire('pointerdown', { clientX: imgRect.left + 100, clientY: imgRect.top + 120, target: drag2 })
  ok('pointerdown 仍被 window 捕获截断', pr.stoppedAt === 'immediate' && pr.reachedDocument === false,
    'stoppedAt=' + pr.stoppedAt + ' reachedDocument=' + pr.reachedDocument)
  ok('在图片上按下没有启动卡片拖动', card.classList.contains('_lps-dragging') === false)

  console.log('\n[7] 字节没备好时整场取消拖拽（不再退化拖地址）')
  // 关掉当前卡
  const head1 = card.childNodes.find((n) => n.tagName === 'HEADER')
  const x1 = head1.childNodes.find((n) => n.classList.contains('_lps-x'))
  fire('pointerdown', { clientX: 0, clientY: 0, target: x1 })
  fire('click', { clientX: 0, clientY: 0, target: x1 })
  ok('第一张卡已关闭', !cardEl())

  // 让 /file 永远不 settle：prefetch 会一直挂着，dragstart 时手里没有 File。
  // 注意 vm context 的全局对象就是 sandbox 本身，替换 sandbox.fetch 对已注入脚本即时生效。
  const realFetch = sandbox.fetch
  sandbox.fetch = function (url, init) {
    if (url.indexOf('/file?') >= 0) return new Promise(() => { /* never settles */ })
    return realFetch(url, init)
  }

  const card2 = await grabCard()
  const drag3 = dragSrcEl()
  ok('第二张卡已创建且带拖源', !!card2 && !!drag3)
  if (drag3) {
    const dt2 = makeDataTransfer()
    dt2.items.owner = dt2
    let pd = false
    drag3._listeners.get('dragstart')[0]({
      type: 'dragstart', target: drag3, dataTransfer: dt2, preventDefault() { pd = true },
    })
    ok('取消了这次拖拽（preventDefault）', pd === true, String(pd))
    ok('没往 items 里塞假文件', dt2._items.length === 0, 'n=' + dt2._items.length)
    ok('没有 Files', dt2.types.indexOf('Files') < 0, JSON.stringify(dt2.types))
    ok('没有 text/uri-list（不诱导原生拖拽）', dt2.types.indexOf('text/uri-list') < 0, JSON.stringify(dt2.types))
  }
  sandbox.fetch = realFetch

  report()
}

function report() {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + '  (' + pass + ' passed)')
  process.exitCode = fail === 0 ? 0 : 1
}

scenario()
