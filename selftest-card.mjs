/**
 * selftest-card.mjs —— 校验截图预览卡的三件事
 *
 *   1) 默认落点主动躲开鲸鱼桌宠（dsh-whale-widget 的 .dshwv-root）
 *   2) 卡片能被拖动，位置写进 localStorage 并下次沿用
 *   3) 卡片上的 pointer / click 在 window 捕获阶段就被截断，
 *      不会漏给鲸鱼的 isWhaleHit 几何命中逻辑（那是「点关闭却点到桌宠」的成因）
 *
 * 跑：ELECTRON_RUN_AS_NODE=1 "E:/DSH/DeepSeek Harness.exe" selftest-card.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, 'lib', 'shot.js'), 'utf8')

const W = 1280
const H = 800
// 真实鲸鱼：fixed right:0 bottom:0，250px 方块（--dshw-base 在 1081 高的窗口里就是 250px）
const WHALE = { left: W - 250, top: H - 250, right: W, bottom: H }

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
    classList: classSet(),
    setAttribute(k, v) { this._attrs.set(String(k), String(v)) },
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
    focus() { document._active = this },
    dispatchEvent(ev) {
      const ls = this._listeners.get(ev.type) || []
      for (const fn of ls) fn(ev)
      return !ev.defaultPrevented
    },
    getBoundingClientRect() { return elRect(this) },
    closest(sel) { return closestOf(this, sel) },
  }
  // className 与 classList 双向同步（真浏览器就是同一个值的两种视图）
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
  // composer 相关选择器：真的宿主那边是 CodeMirror 的 .cm-content[contenteditable="true"]
  if (sel === '.cm-content') return el.classList.contains('cm-content')
  if (sel === '.cm-content,[data-lexical-editor="true"]') {
    return el.classList.contains('cm-content') || el.getAttribute('data-lexical-editor') === 'true'
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
whaleEl.classList.add('dshwv-root')
whaleEl._rect = WHALE

const body = makeEl('body')

// 假 composer：模拟宿主的 CodeMirror 编辑区，用来验证「发到输入框」的粘贴通道
let composerEl = null
function makeComposer() {
  const el = makeEl('div')
  el.className = 'cm-content'
  el.classList.add('cm-content')
  el.setAttribute('contenteditable', 'true')
  el._rect = { left: 600, top: 900, width: 900, height: 40, right: 1500, bottom: 940 }
  el.addEventListener('paste', (ev) => {
    if (!ev.clipboardData) return
    const items = ev.clipboardData.items || []
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue
      const f = items[i].getAsFile()
      if (f) { pasteIntake.push(f); ev.preventDefault() }
    }
  })
  return el
}
const pasteIntake = []

const document = {
  head: makeEl('head'),
  body,
  documentElement: makeEl('html'),
  _listeners: new Map(),
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  getElementById(id) {
    const all = [document.head, document.body, document.documentElement]
    const walk = (n) => {
      if (!n) return null
      if (n.id === id) return n
      for (const c of n.childNodes || []) {
        const r = walk(c)
        if (r) return r
      }
      return null
    }
    for (const root of all) {
      const r = walk(root)
      if (r) return r
    }
    return null
  },
  querySelector(sel) { return sel === '.dshwv-root' ? whaleEl : null },
  querySelectorAll(sel) {
    if (sel === '.cm-content[contenteditable="true"],[data-lexical-editor="true"],[contenteditable="true"]') {
      return composerEl ? [composerEl] : []
    }
    return []
  },
  addEventListener(type, fn, capture) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push({ fn, capture: capture === true })
  },
  removeEventListener() {},
  execCommand() { return true },
}

const store = new Map()
const window = {
  innerWidth: W,
  innerHeight: H,
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
composerEl = makeComposer()
body.appendChild(composerEl)

const captured = []
// 极简 File：只要有 name / type / size，够 shot.js 塞进 dataTransfer 就行
class FakeFile {
  constructor(parts, name, opts) {
    this._parts = parts
    this.name = String(name)
    this.type = (opts && opts.type) || ''
    this.size = 1234
  }
}
/** 极简 DataTransfer：items.add(File) 之后 types 里出现 'Files'、files 里能取回 */
class FakeDataTransfer {
  constructor() {
    this._files = []
    this._data = new Map()
    const self = this
    this.items = {
      add(f) { self._files.push(f); return null },
      get length() { return self._files.length },
    }
    // 让 items[i] 取到类似 DataTransferItem 的对象（宿主 paste 处理就是这么读的）
    this.items = new Proxy(this.items, {
      get(t, k) {
        if (k === 'add' || k === 'length') {
          return k === 'length' ? self._files.length : t.add
        }
        const i = Number(k)
        if (Number.isInteger(i) && self._files[i]) {
          const f = self._files[i]
          return { kind: 'file', type: f.type, getAsFile: () => f }
        }
        return undefined
      },
    })
  }
  get files() { return this._files }
  get types() {
    const t = Array.from(this._data.keys())
    if (this._files.length) t.push('Files')
    return t
  }
  setData(k, v) { this._data.set(String(k), String(v)) }
  getData(k) { return this._data.has(String(k)) ? this._data.get(String(k)) : '' }
}
/** 极简 ClipboardEvent：构造时把 clipboardData 挂上（真 Chromium 也支持） */
class FakeClipboardEvent {
  constructor(type, init) {
    this.type = type
    this.clipboardData = (init && init.clipboardData) || null
    this.bubbles = !!(init && init.bubbles)
    this.cancelable = !!(init && init.cancelable)
    this.defaultPrevented = false
  }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() {}
  stopImmediatePropagation() {}
}
const sandbox = {
  window,
  document,
  navigator: { clipboard: null },
  console,
  setTimeout,
  clearTimeout,
  Date,
  File: FakeFile,
  Blob: FakeFile,
  DataTransfer: FakeDataTransfer,
  ClipboardEvent: FakeClipboardEvent,
  localStorage: window.localStorage,
  fetch(url, init) {
    if (init && init.body) captured.push({ url, body: JSON.parse(init.body) })
    return Promise.resolve({
      // prefetchCardFile 要的是字节流；诊断 /log 走的是 json()
      blob: () => Promise.resolve(new FakeFile([], 'blob', { type: 'image/png' })),
      json: () => Promise.resolve({
        ok: true,
        name: 'shot-20260101-000000-000.png',
        file: 'C:/tmp/shot-20260101-000000-000.png',
        width: 200, height: 160, clipboard: false, aspectMismatch: false,
      }),
    })
  },
}
sandbox.window.localStorage = window.localStorage

const ctx = createContext(sandbox)
runInContext(SRC, ctx, { filename: 'shot.js' })

/**
 * 按 DOM 真实顺序派发：window 捕获 → document 捕获 → （我们只关心捕获侧）。
 * 返回被截断的事件信息，用来断言「没漏到鲸鱼那一层」。
 */
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
const findTag = (root, tag) => {
  let found = null
  const walk = (n) => {
    if (!n || found) return
    if (n.tagName === tag) { found = n; return }
    ;(n.childNodes || []).forEach(walk)
  }
  walk(root)
  return found
}
const findByClass = (root, cls) => {
  let found = null
  const walk = (n) => {
    if (!n || found) return
    if (n.classList && n.classList.contains(cls)) { found = n; return }
    ;(n.childNodes || []).forEach(walk)
  }
  walk(root)
  return found
}
const findBtn = (act) => {
  const c = cardEl()
  if (!c) return null
  let found = null
  const walk = (n) => {
    if (n.hasAttribute && n.hasAttribute('data-act') && n.getAttribute('data-act') === act) found = n
    ;(n.childNodes || []).forEach(walk)
  }
  walk(c)
  return found
}

async function scenario() {
  console.log('\n[1] 长按 → 拖框 → 松手，弹出预览卡')
  fire('pointerdown', { clientX: 100, clientY: 100 })
  await sleep(650)
  fire('pointermove', { clientX: 300, clientY: 260 })
  fire('pointerup', { clientX: 300, clientY: 260 })
  await sleep(80)
  const card = cardEl()
  ok('预览卡已创建', !!card)
  if (!card) { report(); return }

  console.log('\n[2] 默认位置躲开鲸鱼')
  const r = elRect(card)
  const hitWhale = !(r.right <= WHALE.left || WHALE.right <= r.left || r.bottom <= WHALE.top || WHALE.bottom <= r.top)
  ok('卡片不与鲸鱼矩形相交', !hitWhale,
    JSON.stringify({ card: [r.left, r.top, r.right, r.bottom], whale: [WHALE.left, WHALE.top] }))
  ok('卡片在视口内', r.left >= 0 && r.top >= 0 && r.right <= W && r.bottom <= H,
    JSON.stringify([r.left, r.top, r.right, r.bottom]))
  ok('走的是 left/top 内联定位', card.style.left === Math.round(parseFloat(card.style.left)) + 'px' || /\d+px/.test(card.style.left),
    'left=' + card.style.left + ' top=' + card.style.top)
  ok('right/bottom 被清成 auto', card.style.right === 'auto' && card.style.bottom === 'auto',
    card.style.right + '/' + card.style.bottom)

  console.log('\n[3] 拖动卡片：只能从 header 拖')
  const header = card.childNodes.find((n) => n.tagName === 'HEADER')
  ok('有 header（拖动把手）', !!header)

  const before = elRect(card)
  // 在图片区域按下：不该开始拖动
  const img = findTag(card, 'IMG')
  ok('卡片里有 img 缩略图', !!img)
  fire('pointerdown', { clientX: before.left + 100, clientY: before.top + 120, target: img })
  fire('pointermove', { clientX: before.left + 200, clientY: before.top + 220, target: body })
  fire('pointerup', { clientX: before.left + 200, clientY: before.top + 220, target: body })
  const afterImg = elRect(card)
  ok('图片区按下不拖动', afterImg.left === before.left && afterImg.top === before.top,
    JSON.stringify([afterImg.left, afterImg.top]))

  // 在 header 上按下并拖动
  const sx = before.left + 60
  const sy = before.top + 12
  fire('pointerdown', { clientX: sx, clientY: sy, target: header })
  fire('pointermove', { clientX: sx - 120, clientY: sy + 90, target: body })
  fire('pointerup', { clientX: sx - 120, clientY: sy + 90, target: body })
  const afterDrag = elRect(card)
  ok('header 拖动生效（左移 120 / 下移 90）',
    afterDrag.left === before.left - 120 && afterDrag.top === before.top + 90,
    JSON.stringify({ before: [before.left, before.top], after: [afterDrag.left, afterDrag.top] }))
  ok('位置写进了 localStorage', !!store.get('dsh-longpress-shot:cardPos'), String(store.get('dsh-longpress-shot:cardPos')))
  ok('拖动结束清掉 _lps-dragging', !card.classList.contains('_lps-dragging'))

  console.log('\n[4] 点击在 window 捕获阶段被截断（不漏给鲸鱼几何命中）')
  const closeBtn = findBtn('close')
  const headerEl = card.childNodes.find((n) => n.tagName === 'HEADER')
  const xBtn = headerEl.childNodes.find((n) => n.classList.contains('_lps-x'))
  ok('有关闭按钮', !!closeBtn)
  ok('有 ✕ 按钮', !!xBtn)

  // 真实点击 = pointerdown 打头。上一节刚拖过，浏览器会补一个 click，
  // 所以这里必须从 pointerdown 开始，才代表「用户真的去点按钮」。
  fire('pointerdown', { clientX: 0, clientY: 0, target: xBtn })
  const ev1 = fire('click', { clientX: 0, clientY: 0, target: xBtn })
  ok('✕ 的 click 在 window 层就被截断', ev1.stoppedAt === 'immediate' && ev1.reachedDocument === false,
    'stoppedAt=' + ev1.stoppedAt + ' reachedDocument=' + ev1.reachedDocument)
  ok('✕ 真的把卡片关了', !cardEl())

  console.log('\n[4b] 拖完松手补发的那个 click 不触发按钮')
  // 重新抓一张，拖一下，再模拟浏览器补发的 click（没有前置 pointerdown）
  fire('pointerdown', { clientX: 200, clientY: 200 })
  await sleep(650)
  fire('pointermove', { clientX: 400, clientY: 360 })
  fire('pointerup', { clientX: 400, clientY: 360 })
  await sleep(80)
  const c3 = cardEl()
  ok('第三张预览卡已创建', !!c3)
  if (c3) {
    const h3 = c3.childNodes.find((n) => n.tagName === 'HEADER')
    const r3 = elRect(c3)
    fire('pointerdown', { clientX: r3.left + 40, clientY: r3.top + 10, target: h3 })
    fire('pointermove', { clientX: r3.left - 30, clientY: r3.top + 60, target: body })
    fire('pointerup', { clientX: r3.left - 30, clientY: r3.top + 60, target: body })
    // 浏览器补发的 click：target 落在 ✕ 上（拖动终点正好压在 ✕ 时才危险）
    const x3 = h3.childNodes.find((n) => n.classList.contains('_lps-x'))
    fire('click', { clientX: 0, clientY: 0, target: x3 })
    ok('补发的 click 没有关掉卡片', !!cardEl())
  }

  console.log('\n[5] 卡片外的点击不受影响（不误伤页面）')
  const outsideEv = fire('click', { clientX: 10, clientY: 10, target: body })
  ok('卡片外 click 不截断', outsideEv.stoppedAt === null, 'stoppedAt=' + outsideEv.stoppedAt)

  console.log('\n[6] pointerdown 在卡片上也被截断（不会触发遮罩长按检测）')
  const outsideDown = fire('pointerdown', { clientX: 10, clientY: 10, target: body })
  ok('卡片外 pointerdown 不截断', outsideDown.stoppedAt === null, 'stoppedAt=' + outsideDown.stoppedAt)

  console.log('\n[7] 位置记忆：再抓一次，卡片落在上次拖到的位置')
  captured.length = 0
  fire('pointerdown', { clientX: 200, clientY: 200 })
  await sleep(650)
  fire('pointermove', { clientX: 400, clientY: 360 })
  fire('pointerup', { clientX: 400, clientY: 360 })
  await sleep(80)
  const card2 = cardEl()
  ok('第二张预览卡已创建', !!card2)
  if (card2) {
    const r2 = elRect(card2)
    const saved = JSON.parse(store.get('dsh-longpress-shot:cardPos'))
    ok('落在 localStorage 记的位置', r2.left === saved.left && r2.top === saved.top,
      JSON.stringify({ r2: [r2.left, r2.top], saved }))
  }

  console.log('\n[9] 拖进对话框的拖源是 div._lps-drag，不是 img')
  const card9 = cardEl()
  ok('卡片里有拖源 div', !!card9 && !!findByClass(card9, '_lps-drag'))
  const dragSrc = card9 ? findByClass(card9, '_lps-drag') : null
  const img9 = card9 ? findTag(card9, 'IMG') : null
  ok('拖源 div draggable=true', !!dragSrc && dragSrc.getAttribute('draggable') === 'true',
    dragSrc && String(dragSrc.getAttribute('draggable')))
  ok('img draggable=false（关掉原生图片拖拽）', !!img9 && img9.getAttribute('draggable') === 'false',
    img9 && String(img9.getAttribute('draggable')))
  ok('img 在拖源 div 里面', !!img9 && img9.parentNode === dragSrc)

  // 等 prefetchCardFile 的 blob 落地
  await sleep(30)
  const fake = {
    dataTransfer: {
      effectAllowed: '',
      types: [],
      files: [],
      items: {
        add(f) { fake.dataTransfer.files.push(f); fake.dataTransfer.types.push('Files') },
      },
      setData(t) { fake.dataTransfer.types.push(t) },
    },
    preventDefault() { this._pd = true },
    _pd: false,
  }
  // 从拖源 div 派发 dragstart（捕获侧没关系，我们直接在元素上挂的 listener）
  const ls = dragSrc && dragSrc._listeners ? (dragSrc._listeners.get('dragstart') || []) : []
  ok('拖源 div 上挂了 dragstart', ls.length === 1, String(ls.length))
  for (const fn of ls) fn(fake)
  ok('dataTransfer 里有 1 个真实 File', fake.dataTransfer.files.length === 1,
    String(fake.dataTransfer.files.length))
  ok('File 名字是 shot-*.png（不是 file.png）',
    !!fake.dataTransfer.files[0] && /^shot-.*\.png$/.test(fake.dataTransfer.files[0].name),
    fake.dataTransfer.files[0] && fake.dataTransfer.files[0].name)
  ok('没有 DownloadURL（否则 Chromium 会顶掉真实 File）',
    fake.dataTransfer.types.indexOf('DownloadURL') < 0, fake.dataTransfer.types.join('|'))
  ok('没有 text/uri-list', fake.dataTransfer.types.indexOf('text/uri-list') < 0,
    fake.dataTransfer.types.join('|'))
  ok('没有取消拖拽', fake._pd === false, String(fake._pd))

  console.log('\n[10] 「发到输入框」按钮走粘贴通道')
  const card10 = cardEl()
  ok('卡片上有「发到输入框」按钮', !!findBtn('send'))
  const sendLabel = findBtn('send') ? findBtn('send').textContent : ''
  ok('按钮文案是「发到输入框」', sendLabel === '发到输入框', sendLabel)

  pasteIntake.length = 0
  fire('pointerdown', { clientX: 0, clientY: 0, target: findBtn('send') })
  fire('click', { clientX: 0, clientY: 0, target: findBtn('send') })
  await sleep(20)
  ok('粘贴事件把文件递给了 composer', pasteIntake.length === 1, String(pasteIntake.length))
  ok('递过去的是那张截图（名字对）',
    pasteIntake.length === 1 && /^shot-.*\.png$/.test(pasteIntake[0].name),
    pasteIntake[0] && pasteIntake[0].name)
  ok('MIME 是 image/png', pasteIntake.length === 1 && pasteIntake[0].type === 'image/png',
    pasteIntake[0] && pasteIntake[0].type)

  console.log('\n[11] 拖到输入框但 Chromium 吞掉 Files 时，drop 兜底改走粘贴')
  pasteIntake.length = 0
  // 起手：从拖源 div 派发 dragstart（真 File 进 dataTransfer）
  const card11 = cardEl()
  const dragSrc11 = findByClass(card11, '_lps-drag')
  const dtFake = new FakeDataTransfer()
  const dragStartEv = { dataTransfer: dtFake, preventDefault() {} }
  for (const fn of (dragSrc11._listeners.get('dragstart') || [])) fn(dragStartEv)
  ok('dragstart 塞进了 1 个 File', dtFake.files.length === 1, String(dtFake.files.length))

  // dragover 落在 composer 上（宿主那份 dataTransfer 没有 Files —— 真机就是这样）
  const emptyDt = new FakeDataTransfer()
  const overEv = { type: 'dragover', dataTransfer: emptyDt, target: composerEl, preventDefault() {} }
  for (const r of (document._listeners.get('dragover') || [])) r.fn(overEv)
  ok('dragover 时没 Files（复现真机现象）', emptyDt.types.indexOf('Files') < 0, emptyDt.types.join('|'))

  // drop 落在 composer 上，宿主会因 types 没有 Files 直接 return
  let dropPrevented = false
  const dropEv = {
    type: 'drop', dataTransfer: emptyDt, target: composerEl,
    preventDefault() { dropPrevented = true },
    stopPropagation() {},
  }
  for (const r of (document._listeners.get('drop') || [])) r.fn(dropEv)
  await sleep(20)
  ok('drop 兜底把文件插进了 composer', pasteIntake.length === 1, String(pasteIntake.length))
  ok('兜底时 preventDefault，避免浏览器默认行为', dropPrevented === true, String(dropPrevented))

  // drop 之后 dragend：不该再插一次
  const dragendEv = { type: 'dragend', dataTransfer: emptyDt, target: card11 }
  for (const r of (window._listeners.get('dragend') || [])) r.fn(dragendEv)
  await sleep(20)
  ok('dragend 不重复插入', pasteIntake.length === 1, String(pasteIntake.length))

  console.log('\n[12] 拖到非输入框区域不误插')
  pasteIntake.length = 0
  const card12 = cardEl()
  const dragSrc12 = findByClass(card12, '_lps-drag')
  const dt2 = new FakeDataTransfer()
  for (const fn of (dragSrc12._listeners.get('dragstart') || [])) fn({ dataTransfer: dt2, preventDefault() {} })
  const emptyDt2 = new FakeDataTransfer()
  for (const r of (document._listeners.get('dragover') || [])) {
    r.fn({ type: 'dragover', dataTransfer: emptyDt2, target: body, preventDefault() {} })
  }
  for (const r of (document._listeners.get('drop') || [])) {
    r.fn({ type: 'drop', dataTransfer: emptyDt2, target: body, preventDefault() {}, stopPropagation() {} })
  }
  for (const r of (window._listeners.get('dragend') || [])) {
    r.fn({ type: 'dragend', dataTransfer: emptyDt2, target: card12 })
  }
  await sleep(20)
  ok('落在空白处不插文件', pasteIntake.length === 0, String(pasteIntake.length))

  report()
}

function report() {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + '  (' + pass + ' passed)')
  process.exitCode = fail === 0 ? 0 : 1
}

scenario()
