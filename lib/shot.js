/**
 * dsh-longpress-shot —— 浏览器端半区（注入到页面，普通 ESM，无构建步骤）
 *
 * 交互：
 *   鼠标左键按住 ≥ 550ms（期间位移不超过 6px）→ 触发。
 *   触发那一刻左键其实还按着，遮罩是新出来的、收不到那次 pointerdown，
 *   所以 beginSelection 直接以 armed=true 继承"按住这一笔"，任何 move 都算拖框：
 *     · 继续拖动 → 框选区域，松开即抓该区域
 *     · 没拖就松开 → 留在遮罩里等下一次按下再拖（不会误抓整窗）
 *     · 遮罩里双击 / 按 Enter → 抓整个 DSH 窗口
 *     · 右键 或 Esc → 取消，不抓
 *   抓完在右上角弹预览卡：缩略图 + 文件路径 + 「另存为 / 复制路径 / 关闭」。
 *   卡片可以按住 header 拖动，位置记在 localStorage，下次沿用。
 *   卡片里的缩略图可以按住拖进对话框当附件；拖拽被浏览器拦下时自动改走「粘贴」通道。
 *   v1.11.0 起卡片另有「发到输入框」按钮，直接以合成 ClipboardEvent 把图片塞进 composer。
 *   图片同时已写进系统剪贴板，Ctrl+V 直接能贴进对话框。
 *
 * 不做的事：不在可编辑控件（input / textarea / contenteditable）里触发，避免抢走文本选择。
 */
;(function () {
  'use strict'
  if (window.__DSH_LONGPRESS_SHOT__) return
  window.__DSH_LONGPRESS_SHOT__ = { version: '1.11.2' }

  var HOLD_MS = 550
  var MOVE_TOL = 6
  var API = '/dsh-longpress-shot'
  var POS_KEY = 'dsh-longpress-shot:cardPos'

  var STYLE_ID = 'dsh-longpress-shot-style'
  var CSS = [
    // 遮罩必须压在预览卡（2147483001）和 toast 之上：否则拖框经过卡片区域时，
    // 命中的 target 是卡片，window 捕获的 onShield 会把 pointermove 全吃掉。
    '._lps-overlay{position:fixed;inset:0;z-index:2147483002;background:rgba(8,10,14,.30);',
    'cursor:crosshair;user-select:none;-webkit-user-select:none;}',
    '._lps-overlay[data-idle="1"]{background:rgba(8,10,14,.14);}',
    '._lps-box{position:fixed;z-index:2147483600;border:2px solid #6fb2ff;background:rgba(76,154,255,.10);',
    'box-shadow:0 0 0 9999px rgba(8,10,14,.34),0 0 0 1px rgba(10,14,22,.55),0 0 12px rgba(76,154,255,.55);',
    'pointer-events:none;border-radius:2px;}',
    '._lps-tip{position:fixed;left:50%;top:14px;transform:translateX(-50%);',
    'font:500 12px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;color:#eaf2ff;',
    'background:rgba(20,24,32,.92);padding:6px 12px;border-radius:999px;',
    'border:1px solid rgba(120,160,255,.35);pointer-events:none;white-space:nowrap;}',
    '._lps-badge{position:fixed;z-index:2147483000;pointer-events:none;',
    'font:500 11px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;color:#dbe7ff;',
    'background:rgba(20,24,32,.92);padding:2px 8px;border-radius:999px;',
    'border:1px solid rgba(120,160,255,.35);transform:translate(12px,12px);}',
    // 位置一律由 JS 写内联 left/top（可拖动 + 记忆），CSS 里不给 right/bottom，
    // 否则内联值会和 right/bottom 打架、拖动时卡片会自己跳。
    '._lps-card{position:fixed;left:0;top:0;z-index:2147483001;width:340px;',
    'background:#141821;color:#e6ecf7;border:1px solid rgba(120,160,255,.28);border-radius:10px;',
    'box-shadow:0 12px 32px rgba(0,0,0,.45);overflow:hidden;',
    'font:400 12px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;}',
    '._lps-card header{display:flex;align-items:center;justify-content:space-between;gap:8px;',
    'padding:8px 10px;font-weight:600;font-size:12px;background:rgba(255,255,255,.04);',
    'cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;}',
    '._lps-card._lps-dragging header{cursor:grabbing;}',
    '._lps-card._lps-dragging{box-shadow:0 18px 44px rgba(0,0,0,.55);}',
    '._lps-card header ._lps-grip{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '._lps-x{flex:0 0 auto;width:20px;height:20px;line-height:18px;text-align:center;border-radius:5px;',
    'cursor:pointer;opacity:.72;font-size:13px;}',
    '._lps-x:hover{opacity:1;background:rgba(255,120,120,.18);}',
    // 拖进对话框的「拖源」是外层 ._lps-drag 这个 div，不是 <img>。
    // 原因（v1.10.0 定位）：<img draggable> 会让 Chromium 自己起一个原生图片拖拽，
    // 它生成的虚拟 File 名字取自 URL 末段（我们的 URL 是 /dsh-longpress-shot/file?name=…，
    // 于是叫 file.png），并且会在 drop 时把 dragstart 里 items.add 塞进去的真实 File 顶掉。
    // 宿主 @deepseek-ai/dsh-client-ui-attachment 拿到的就是那个读不出字节的虚拟文件，
    // 于是附件摄取静默失败、输入框什么都不出现。
    // 换成 div 当拖源（非 img / 非 a 不会触发原生文件拖拽），img 彻底关掉拖拽、也不吃指针事件。
    '._lps-drag{position:relative;cursor:grab;}',
    '._lps-drag:active{cursor:grabbing;}',
    '._lps-card img{display:block;width:100%;max-height:220px;object-fit:contain;background:#0b0e14;',
    'user-select:none;-webkit-user-select:none;-webkit-user-drag:none;pointer-events:none;}',
    '._lps-meta{padding:6px 10px;color:#8fa3c4;font-size:11px;word-break:break-all;}',
    '._lps-actions{display:flex;gap:6px;padding:0 10px 10px;}',
    '._lps-btn{flex:1;appearance:none;border:1px solid rgba(120,160,255,.3);background:rgba(120,160,255,.10);',
    'color:#dbe7ff;border-radius:6px;padding:5px 0;font-size:11px;cursor:pointer;',
    'font-family:inherit;line-height:1.6;}',
    '._lps-btn:hover{background:rgba(120,160,255,.22);}',
    '._lps-btn[data-kind="primary"]{background:rgba(76,154,255,.30);border-color:rgba(76,154,255,.6);}',
    '._lps-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483001;',
    'background:rgba(20,24,32,.95);color:#ffd9d9;border:1px solid rgba(255,120,120,.4);',
    'padding:8px 14px;border-radius:8px;font:400 12px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;',
    'max-width:70vw;}',
  ].join('')

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return
    var s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = CSS
    ;(document.head || document.documentElement).appendChild(s)
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false
    var tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (el.isContentEditable) return true
    try {
      if (el.closest && el.closest('[contenteditable="true"],[contenteditable=""],input,textarea')) return true
    } catch (e) { /* ignore */ }
    return false
  }

  // ---------------- 长按检测 ----------------
  var hold = null // { timer, x, y, badge }

  function clearHold(triggered) {
    if (!hold) return
    var b = hold.badge
    var fired = hold.fired === true
    try { clearTimeout(hold.timer) } catch (e) { /* ignore */ }
    hold = null
    if (b && b.parentNode) {
      if (fired || triggered) { b.parentNode.removeChild(b) }
      else {
        b.style.opacity = '0'
        setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b) }, 140)
      }
    }
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return
    if (ev.isPrimary === false) return
    if (state.active) return
    if (isEditable(ev.target)) return
    if (ev.target && ev.target.closest && ev.target.closest('._lps-overlay')) return

    clearHold()
    var badge = document.createElement('div')
    badge.className = '_lps-badge'
    badge.textContent = '长按…截图'
    badge.style.left = ev.clientX + 'px'
    badge.style.top = ev.clientY + 'px'
    badge.style.opacity = '0'
    badge.style.transition = 'opacity .12s linear'

    var h = { x: ev.clientX, y: ev.clientY, badge: badge, fired: false, timer: null }
    hold = h

    try {
      ensureStyle()
      ;(document.body || document.documentElement).appendChild(badge)
    } catch (e) { /* ignore */ }

    setTimeout(function () { if (hold === h) badge.style.opacity = '1' }, 90)

    h.timer = setTimeout(function () {
      if (hold !== h) return
      h.fired = true
      var sx = h.x
      var sy = h.y
      clearHold(true)
      beginSelection(sx, sy)
    }, HOLD_MS)
  }

  function onPointerMove(ev) {
    if (!hold) return
    if (Math.abs(ev.clientX - hold.x) > MOVE_TOL || Math.abs(ev.clientY - hold.y) > MOVE_TOL) {
      clearHold()
      return
    }
    hold.badge.style.left = ev.clientX + 'px'
    hold.badge.style.top = ev.clientY + 'px'
  }

  function onPointerUp() { clearHold() }
  function onPointerCancel() { clearHold() }

  // ---------------- 选区遮罩 ----------------
  var state = { active: false }

  function beginSelection(sx, sy) {
    if (state.active) return
    state.active = true
    ensureStyle()

    var overlay = document.createElement('div')
    overlay.className = '_lps-overlay'
    overlay.setAttribute('data-idle', '1')

    var tip = document.createElement('div')
    tip.className = '_lps-tip'
    tip.textContent = '继续拖动框选区域 · 双击 / Enter = 整窗截图 · Esc / 右键 取消'

    var box = document.createElement('div')
    box.className = '_lps-box'
    box.style.display = 'none'

    overlay.appendChild(tip)
    ;(document.body || document.documentElement).appendChild(overlay)
    document.body.appendChild(box)

    // 关键：遮罩是左键仍被按住时创建的，那一次 pointerdown 早过去了。
    // 所以这里不能等新的 pointerdown 才开始框选，必须直接继承按住的这一笔：
    //   armed = true 表示"触发用的那一次按下还没松开"，此时任何 pointermove 都算拖框。
    var armed = true
    var dragging = false
    var origin = { x: sx, y: sy }
    var rect = { x: 0, y: 0, w: 0, h: 0 }
    var done = false
    // 自己判双击，不用 ev.detail：触发用的那一次按下已经算过一次点击，
    // 浏览器会把遮罩里的第一次按下也当成 detail=2，直接信它会误抓整窗。
    var lastDownAt = 0
    var lastDownPos = null
    var DOUBLE_MS = 320
    var DOUBLE_PX = 6

    function paint(x0, y0, x1, y1) {
      var left = Math.min(x0, x1)
      var top = Math.min(y0, y1)
      var w = Math.abs(x1 - x0)
      var h = Math.abs(y1 - y0)
      rect = { x: left, y: top, w: w, h: h }
      box.style.display = 'block'
      box.style.left = left + 'px'
      box.style.top = top + 'px'
      box.style.width = w + 'px'
      box.style.height = h + 'px'
      overlay.removeAttribute('data-idle')
      dbgTip()
    }

    function dbgTip() {
      tip.textContent = '继续拖动框选区域 · 双击 / Enter = 整窗截图 · Esc / 右键 取消'
    }

    function reset() {
      dragging = false
      armed = false
      rect = { x: 0, y: 0, w: 0, h: 0 }
      box.style.display = 'none'
      overlay.setAttribute('data-idle', '1')
    }

    function wholeWindow() {
      var vw = window.innerWidth || 1
      var vh = window.innerHeight || 1
      teardown()
      capture({ x: 0, y: 0, w: 1, h: 1, aspect: vw / vh })
    }

    function submitSelection() {
      var vw = window.innerWidth || 1
      var vh = window.innerHeight || 1
      var payload = {
        x: rect.x / vw,
        y: rect.y / vh,
        w: rect.w / vw,
        h: rect.h / vh,
        aspect: vw / vh,
      }
      diag('submit', { rx: rect.x, ry: rect.y, rw: rect.w, rh: rect.h, vw: vw, vh: vh })
      teardown()
      capture(payload)
    }

    function teardown() {
      if (done) return
      done = true
      state.active = false
      try { overlay.remove() } catch (e) { /* ignore */ }
      try { box.remove() } catch (e) { /* ignore */ }
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', onCancel, true)
      document.removeEventListener('keydown', onKey, true)
      overlay.removeEventListener('contextmenu', onContext)
      window.removeEventListener('blur', onCancel)
    }

    function onDown(ev) {
      if (done) return
      if (ev.button !== 0) return
      ev.preventDefault()
      ev.stopPropagation()
      // 遮罩里再按一下、且和上一次按下离得很近 → 双击，抓整窗
      if (isDouble(ev.clientX, ev.clientY)) { wholeWindow(); return }
      armed = false
      dragging = true
      origin = { x: ev.clientX, y: ev.clientY }
      rect = { x: 0, y: 0, w: 0, h: 0 }
      box.style.display = 'none'
      try { overlay.setPointerCapture(ev.pointerId) } catch (e) { /* ignore */ }
    }

    function isDouble(x, y) {
      var now = Date.now()
      var near = lastDownPos !== null &&
        Math.abs(x - lastDownPos.x) <= DOUBLE_PX &&
        Math.abs(y - lastDownPos.y) <= DOUBLE_PX
      var quick = now - lastDownAt <= DOUBLE_MS
      lastDownAt = now
      lastDownPos = { x: x, y: y }
      return near && quick
    }

    function onMove(ev) {
      if (done) return
      if (!dragging) {
        // 触发用的那一笔还没松手：移动超过 2px 就直接进入框选
        if (!armed) return
        if (Math.abs(ev.clientX - origin.x) < 2 && Math.abs(ev.clientY - origin.y) < 2) return
        dragging = true
      }
      ev.preventDefault()
      paint(origin.x, origin.y, ev.clientX, ev.clientY)
    }

    function onUp(ev) {
      if (done) return
      ev.preventDefault()
      ev.stopPropagation()
      if (dragging && rect.w >= 8 && rect.h >= 8) { submitSelection(); return }
      // 没拖出有效框（含"长按后直接松手"）→ 留在遮罩里等下一次拖动，不自动抓整窗
      reset()
      toast('未框选 · 继续拖动框选，双击抓整窗，Esc 取消', 2400)
    }

    function onCancel(ev) {
      if (done) return
      if (ev && ev.type === 'pointercancel') {
        ev.preventDefault()
        ev.stopPropagation()
      }
      teardown()
    }

    function onContext(ev) {
      ev.preventDefault()
      ev.stopPropagation()
      teardown()
    }

    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        teardown()
        return
      }
      if (ev.key === 'Enter') {
        ev.preventDefault()
        ev.stopPropagation()
        wholeWindow()
      }
    }

    // 全部挂在 document 捕获阶段：触发时遮罩还不存在，pointerdown 已经派发过了，
    // 只有挂在 document 上才能接住"按住不放继续拖"的后续 move / up。
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onCancel, true)
    document.addEventListener('keydown', onKey, true)
    overlay.addEventListener('contextmenu', onContext)
    window.addEventListener('blur', onCancel)
  }

  // ---------------- 诊断上报（临时，定位视口/物理像素错位） ----------------
  function diag(tag, extra) {
    try {
      var vv = window.visualViewport
      var rec = {
        tag: tag,
        t: Date.now(),
        iw: window.innerWidth,
        ih: window.innerHeight,
        ow: window.outerWidth,
        oh: window.outerHeight,
        dpr: window.devicePixelRatio,
        sx: window.screenX,
        sy: window.screenY,
        sw: screen.width,
        sh: screen.height,
        aw: screen.availWidth,
        ah: screen.availHeight,
        vv: vv ? { w: Math.round(vv.width * 100) / 100, h: Math.round(vv.height * 100) / 100, scale: vv.scale, ox: vv.offsetLeft, oy: vv.offsetTop } : null,
        cw: document.documentElement ? document.documentElement.clientWidth : null,
        ch: document.documentElement ? document.documentElement.clientHeight : null,
        dpr2: window.devicePixelRatio,
        zoom: (function () { try { return window.getComputedStyle(document.documentElement).zoom } catch (e) { return null } })(),
      }
      if (extra) for (var k in extra) rec[k] = extra[k]
      fetch(API + '/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec),
        keepalive: true,
      }).catch(function () { /* ignore */ })
    } catch (e) { /* ignore */ }
  }

  // ---------------- 抓屏请求 ----------------
  function capture(payload) {
    var body = {
      x: payload.x, y: payload.y, w: payload.w, h: payload.h,
      aspect: payload.aspect, clipboard: true,
    }
    diag('capture', { px: payload.x, py: payload.y, pw: payload.w, ph: payload.h, aspect: payload.aspect })
    toast('正在抓取…', 900)
    fetch(API + '/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json() }).then(function (res) {
      if (!res || !res.ok) {
        toast('抓屏失败：' + ((res && (res.error || res.detail)) || '未知错误'), 4200)
        return
      }
      showCard(res)
    }).catch(function (err) {
      toast('抓屏请求失败：' + (err && err.message ? err.message : String(err)), 4200)
    })
  }

  // ---------------- 预览卡 ----------------
  var card = null

  // 预览卡那张图「拖进对话框」要用的 File。
  // 宿主的拖放接收入口（@deepseek-ai/dsh-client-ui-attachment 的 installDocumentDropEvents）
  // 第一件事就是 `dataTransfer.types.includes("Files")`，光有 text/uri-list 不算附件，
  // 所以必须真的往 dataTransfer 里塞一个 File 对象。
  // 浏览器不允许在 dragstart 里现取（异步 fetch 赶不上），所以卡片一出现就先把字节流备好。
  var cardFile = null   // { name, file } | null
  var cardFileErr = null

  function closeCard() {
    if (card && card.parentNode) card.parentNode.removeChild(card)
    card = null
    cardFile = null
    cardFileErr = null
  }

  function prefetchCardFile(name) {
    var want = String(name || '')
    if (!want) return
    cardFile = null
    cardFileErr = null
    try {
      fetch(API + '/file?name=' + encodeURIComponent(want))
        .then(function (r) { return r.blob() })
        .then(function (blob) {
          // 卡片可能已经关掉/换成新的一张了
          if (!card || !card._lpsName || card._lpsName !== want) return
          var f = null
          try {
            f = new File([blob], want, { type: 'image/png' })
          } catch (e) {
            // 极老的内核没有 File 构造器，退化成 Blob + name 字段（宿主也能吃）
            f = blob
            try { f.name = want } catch (e2) { /* ignore */ }
          }
          cardFile = { name: want, file: f }
        })
        .catch(function (err) {
          cardFileErr = err && err.message ? err.message : String(err)
        })
    } catch (e) { cardFileErr = String(e) }
  }

  function absUrl(pathname) {
    var origin = ''
    try { origin = (window.location && window.location.origin) || '' } catch (e) { origin = '' }
    return origin + pathname
  }

  function dtTypes(dt) {
    try {
      var a = dt && dt.types
      if (!a) return null
      var out = []
      for (var i = 0; i < a.length; i++) out.push(String(a[i]))
      return out.join('|')
    } catch (e) { return 'ERR' }
  }

  function dtFiles(dt) {
    try { return (dt && dt.files) ? Array.prototype.slice.call(dt.files) : [] } catch (e) { return [] }
  }

  /**
   * 拖源的 dragstart：**只**把已备好的真实 File 放进 dataTransfer。
   *
   * v1.10.0 的关键约束（踩过坑，别改回去）：
   *   · 绝对不要 setData('DownloadURL', …)。Chromium 会据此另造一个虚拟 File
   *     （名字取 URL 末段 → file.png），drop 时把 items.add 的真实 File 顶掉，
   *     宿主读到的是读不出字节的虚拟文件 → 附件静默失败。
   *   · 也不要设 text/uri-list：宿主只看 types 里的 'Files'，多这个反而诱导原生拖拽。
   *   · File 没备好时**整场取消拖拽**（preventDefault），宁可拖不动，
   *     也别让一个空拖拽落到输入框里假装成功。
   */
  function onCardDragStart(ev) {
    var dt = ev.dataTransfer
    if (!dt) return
    var name = (card && card._lpsName) || (cardFile && cardFile.name) || ''
    var file = (cardFile && cardFile.file) || null
    dragActive = true
    overComposer = false
    dropRescued = false

    // 字节还没到位：取消这次拖拽，并提示原因（用户重拖一次即可）
    if (!file) {
      try { ev.preventDefault() } catch (e) { /* ignore */ }
      toast(cardFileErr ? ('图片还没准备好：' + cardFileErr) : '图片还在准备，稍等半秒再拖', 2200)
      diag('dragstart-abort', { name: name, err: cardFileErr || 'file-not-ready' })
      return
    }

    try { dt.effectAllowed = 'copy' } catch (e) { /* ignore */ }
    var ok = false
    try {
      if (dt.items && dt.items.add) { dt.items.add(file); ok = true }
    } catch (e) { ok = false }
    // 老内核没有 items.add 时退回老办法（drag 数据里塞 uri-list），但这台机器上走不到
    if (!ok) {
      var url = absUrl(API + '/file?name=' + encodeURIComponent(name))
      try { dt.setData('text/uri-list', url) } catch (e) { /* ignore */ }
      try { dt.setData('text/plain', url) } catch (e) { /* ignore */ }
    }
    diag('dragstart', { name: name, hasFile: ok, types: dtTypes(dt), nfiles: dtFiles(dt).length })
  }

  // ---------------- 送进对话框：粘贴通道 ----------------
  // v1.11.0 的关键事实（真机 diag 实测，别再走回头路）：
  //   · 同页面 DOM 拖拽（dragstart 里 dt.items.add(File)）在 **source 侧**读得到
  //     types='Files' nfiles=1，可一到 dragenter/dragover/drop 就只剩
  //     'text/plain|chromium/x-drag-id'、nfiles=0 —— Chromium 不会把 File 暴露给 target。
  //   · 因此宿主 @deepseek-ai/dsh-client-ui-attachment 的 installDocumentDropEvents
  //     里 `dt.types.includes("Files")` 恒假，onDrop 直接 return，附件永远进不去。
  //   · 而宿主 composer 的粘贴入口（dsh-client-ui-conversation/lib/client.js 的
  //     Je$2 = PASTE_COMMAND 那条 registerCommand）只读 event.clipboardData.items，
  //     kind==='file' → getAsFile() → handlers.intakeFiles(files) —— 这条路不经过
  //     OS 剪贴板，手造 ClipboardEvent 就能喂进去（Chromium 允许 ClipboardEventInit
  //     带 clipboardData，实测 ev.clipboardData.files.length===1、名字与字节都在）。
  // 所以：拖拽仍保留（万一哪天宿主改了 drop 逻辑就能直连），但拖不进去时
  // 由 drop/dragend 兜底改走粘贴；卡片上另给一个显式按钮。

  var dragActive = false      // 本次拖拽是否由卡片缩略图发起
  var overComposer = false    // 拖拽过程中指针是否落在输入框上
  var dropRescued = false     // 本轮拖拽是否已经走过粘贴兜底（防重复插入）

  /** 认知宿主的 composer 编辑区（CodeMirror 的 .cm-content，兜底任意可见 contenteditable）。 */
  function composerEl() {
    var list = null
    try { list = document.querySelectorAll('.cm-content[contenteditable="true"],[data-lexical-editor="true"],[contenteditable="true"]') } catch (e) { list = null }
    if (!list || !list.length) return null
    for (var i = 0; i < list.length; i++) {
      var el = list[i]
      var r = null
      try { r = el.getBoundingClientRect() } catch (e) { r = null }
      if (r && r.width > 40 && r.height > 8) return el
    }
    return null
  }

  /**
   * 判断某个拖拽落点算不算「落在输入框上」。
   * v1.11.2 修的关键点：drop 的 ev.target 往往是 composer 的**外层容器**
   * （DIV.GRgSLq_input / DIV.GRgSLq_card / DIV.GRgSLq_row / BUTTON.GRgSLq_add），
   * 它们是 .cm-content 的**祖先**而不是后代，所以早先只看 `ed.contains(t)` 恒为假，
   * overComposer 一直是 false，兜底 paste 永远不触发 → 表现为「拖进去没反应」。
   * 现在三个方向都认：t 在编辑器里、编辑器在 t 里、指针落在编辑器矩形附近。
   */
  function inComposer(t, ev) {
    var ed = composerEl()
    if (!ed || !t) return false
    try {
      if (ed === t || ed.contains(t)) return true
      if (t.contains && t.contains(ed)) return true
      if (t.closest && t.closest('.cm-content,[data-lexical-editor="true"],.cm-editor') !== null) return true
    } catch (e) { /* ignore */ }
    // 几何兜底：指针落在编辑区矩形（外扩一圈，覆盖工具条与内边距）内就算了
    var x = ev && typeof ev.clientX === 'number' ? ev.clientX : null
    var y = ev && typeof ev.clientY === 'number' ? ev.clientY : null
    if (x === null || y === null) return false
    var r = null
    try { r = ed.getBoundingClientRect() } catch (e2) { r = null }
    if (!r) return false
    var padX = 40
    var padTop = 70
    var padBottom = 30
    return x >= r.left - padX && x <= r.right + padX && y >= r.top - padTop && y <= r.bottom + padBottom
  }

  /**
   * 把 File 以「粘贴」的方式递给宿主 composer。
   * 返回 true 表示事件已被宿主消费（defaultPrevented）或至少派发成功。
   */
  function pasteIntoComposer(file) {
    if (!file) return false
    var ed = composerEl()
    if (!ed) { toast('没找到输入框，先点一下对话输入区再试', 2400); return false }
    var dt = null
    try { dt = new DataTransfer() } catch (e) { dt = null }
    if (!dt) return false
    try { dt.items.add(file) } catch (e) { return false }
    var ev = null
    try {
      ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    } catch (e) { ev = null }
    if (!ev) return false
    try { ed.focus() } catch (e) { /* ignore */ }
    var dispatched = false
    try { dispatched = ed.dispatchEvent(ev) } catch (e) { dispatched = false }
    // dispatchEvent 返回 false = 有监听器调了 preventDefault = 宿主认了这次粘贴
    var consumed = !dispatched || !!ev.defaultPrevented
    diag('paste-inject', { name: file.name, size: file.size, consumed: consumed, dispatched: dispatched })
    return consumed
  }

  function sendCardToComposer() {
    var file = (cardFile && cardFile.file) || null
    var name = (card && card._lpsName) || (cardFile && cardFile.name) || ''
    if (!file) {
      toast(cardFileErr ? ('图片还没准备好：' + cardFileErr) : '图片还在准备，稍等半秒再点', 2200)
      return
    }
    if (pasteIntoComposer(file)) toast('已插入对话框：' + name, 2000)
    else toast('插入没生效，可以直接 Ctrl+V 粘贴（截图已在剪贴板）', 3000)
  }

  function showCard(res) {
    closeCard()
    ensureStyle()
    var el = document.createElement('div')
    el.className = '_lps-card'

    var head = document.createElement('header')
    var title = document.createElement('span')
    title.className = '_lps-grip'
    title.textContent = '截图已保存'
    var x = document.createElement('span')
    x.className = '_lps-x'
    x.textContent = '✕'
    x.title = '关闭'
    x.setAttribute('data-act', 'close')
    head.appendChild(title)
    head.appendChild(x)

    var img = document.createElement('img')
    img.src = API + '/file?name=' + encodeURIComponent(res.name)
    img.alt = '截图预览'
    // 这张图要能直接拖进对话框当附件，但**拖源不是 img**：
    //   · img 写死 draggable=false + pointer-events:none，彻底不参与原生拖拽
    //   · 外层 div._lps-drag 才是 draggable=true 的拖源，dragstart 里塞真实 File
    // 细节原因见 onCardDragStart 的注释（img 原生拖拽会把我们的 File 顶成 file.png）。
    img.setAttribute('draggable', 'false')
    img.title = '按住拖到输入框，可直接作为附件'

    var drag = document.createElement('div')
    drag.className = '_lps-drag'
    drag.setAttribute('draggable', 'true')
    drag.title = '按住拖到输入框，可直接作为附件'
    drag.appendChild(img)
    drag.addEventListener('dragstart', onCardDragStart)
    prefetchCardFile(res.name)

    var meta = document.createElement('div')
    meta.className = '_lps-meta'
    meta.textContent = res.width + '×' + res.height + ' · ' + res.name

    var actions = document.createElement('div')
    actions.className = '_lps-actions'

    function btn(label, kind, act) {
      var b = document.createElement('button')
      b.className = '_lps-btn'
      b.textContent = label
      if (kind) b.setAttribute('data-kind', kind)
      b.setAttribute('data-act', act)
      actions.appendChild(b)
      return b
    }

    btn('发到输入框', 'primary', 'send')
    btn('另存为', '', 'save')
    btn('复制路径', '', 'copy')
    btn('关闭', '', 'close')

    el.appendChild(head)
    el.appendChild(drag)
    el.appendChild(meta)
    el.appendChild(actions)
    document.body.appendChild(el)
    card = el
    // prefetchCardFile 里要靠它认「这张卡还是不是原来那张」
    el._lpsName = String(res.name || '')

    // 动作表：click 走全局捕获的 onCardClick（见下），不再给每个按钮单独挂 listener。
    // 原因：鲸鱼挂件在 document 捕获阶段用「几何命中」吞 click，根本不看 target，
    // 卡片即使压在上面也收不到冒泡；只有我们自己也用捕获阶段、并且抢在它之前跑，才拿得到。
    cardActions = {
      send: sendCardToComposer,
      save: function () {
        var a = document.createElement('a')
        a.href = API + '/file?name=' + encodeURIComponent(res.name)
        a.download = res.name
        document.body.appendChild(a)
        a.click()
        a.remove()
      },
      copy: function () {
        copyText(res.file)
        toast('路径已复制', 1400)
      },
      close: closeCard,
    }

    placeCard(el)

    if (res.clipboard) toast('图片已复制到剪贴板，Ctrl+V 可直接粘贴', 2600)
    if (res.aspectMismatch) toast('提示：窗口宽高比与页面不一致，可能抓到的是别的窗口', 3600)
  }

  // ---------------- 预览卡：位置 / 拖动 / 事件隔离 ----------------
  var cardActions = null

  function viewportBox() {
    return {
      w: (typeof window.innerWidth === 'number' ? window.innerWidth : 0) || 0,
      h: (typeof window.innerHeight === 'number' ? window.innerHeight : 0) || 0,
    }
  }

  function clampNum(v, lo, hi) {
    if (hi < lo) return lo
    if (v < lo) return lo
    if (v > hi) return hi
    return v
  }

  /**
   * 默认落点：右上角，并且**主动躲开鲸鱼桌宠**。
   * 鲸鱼（dsh-whale-widget）是 position:fixed right:0 bottom:0 的大方块，
   * 尺寸 clamp(122px … 625px)，在 1081 高的窗口里能一直顶到 y≈456，
   * 光把卡片挪到顶部根本避不开，所以这里直接量它的 rect 再让位。
   */
  function whaleRect() {
    try {
      var el = document.querySelector('.dshwv-root')
      if (!el) return null
      var r = el.getBoundingClientRect()
      if (!r || r.width <= 0 || r.height <= 0) return null
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    } catch (e) { return null }
  }

  function overlaps(a, b) {
    return !(a.left + a.w <= b.left || b.right <= a.left || a.top + a.h <= b.top || b.bottom <= a.top)
  }

  function defaultPos(w, h) {
    var vp = viewportBox()
    var m = 18
    var maxLeft = Math.max(m, vp.w - w - m)
    var maxTop = Math.max(m, vp.h - h - m)
    var pos = { left: clampNum(vp.w - w - m, m, maxLeft), top: clampNum(64, m, maxTop) }

    var wr = whaleRect()
    if (!wr) return pos
    var me = { left: pos.left, top: pos.top, w: w, h: h }
    if (!overlaps(me, wr)) return pos

    // 方案 A：整体挪到鲸鱼左侧
    var leftA = wr.left - w - m
    if (leftA >= m) {
      var a = { left: leftA, top: pos.top, w: w, h: h }
      if (!overlaps(a, wr)) return { left: leftA, top: pos.top }
    }
    // 方案 B：挪到鲸鱼上方
    var topB = wr.top - h - m
    if (topB >= m) {
      var b = { left: pos.left, top: topB, w: w, h: h }
      if (!overlaps(b, wr)) return { left: pos.left, top: topB }
    }
    // 方案 C：左上角兜底（A/B 都放不下时最不可能压到右下角的鲸鱼）
    return { left: clampNum(m, m, maxLeft), top: clampNum(m, m, maxTop) }
  }

  function readPos() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(POS_KEY)
      if (!raw) return null
      var o = JSON.parse(raw)
      if (!o || typeof o.left !== 'number' || typeof o.top !== 'number') return null
      if (!isFinite(o.left) || !isFinite(o.top)) return null
      return { left: o.left, top: o.top }
    } catch (e) { return null }
  }

  function writePos(left, top) {
    try {
      if (window.localStorage) window.localStorage.setItem(POS_KEY, JSON.stringify({ left: left, top: top }))
    } catch (e) { /* 隐私模式 / 配额满：位置不记也没关系 */ }
  }

  /** 把卡片摆到保存在案的位置；没有存档或存档越界（换过显示器 / 窗口变小）就回默认。 */
  function placeCard(el) {
    var r = null
    try { r = el.getBoundingClientRect() } catch (e) { r = null }
    var w = (r && r.width) || 340
    var h = (r && r.height) || 220
    var vp = viewportBox()
    var m = 8
    var pos = readPos()
    if (!pos) pos = defaultPos(w, h)
    pos.left = clampNum(pos.left, m, Math.max(m, vp.w - w - m))
    pos.top = clampNum(pos.top, m, Math.max(m, vp.h - h - m))
    applyPos(el, pos.left, pos.top)
    return pos
  }

  function applyPos(el, left, top) {
    el.style.left = left + 'px'
    el.style.top = top + 'px'
    el.style.right = 'auto'
    el.style.bottom = 'auto'
  }

  var cardDrag = null
  // 拖完松手浏览器仍会补一个 click（target = 松手点所在的元素），
  // 而 click 派发在 pointerup 之后、那时 cardDrag 已清空 → 只能用一次性标记挡。
  // 标记在下一次 pointerdown 时清掉：真实用户点按钮一定带有 pointerdown，
  // 浏览器补发的那个 click 前面没有 pointerdown，正好被吃掉。
  var dragSuppressOnce = false

  function onCardPointerDown(ev) {
    if (!card || !cardActions) return
    if (ev.button !== 0 && ev.pointerType === 'mouse') return
    if (ev.isPrimary === false) return
    var t = ev.target
    // 按钮 / ✕ 不参与拖动，留给 click 处理
    if (t && t.closest && t.closest('[data-act]')) return
    var grip = t && t.closest ? t.closest('._lps-card header') : null
    if (!grip) return

    var r = null
    try { r = card.getBoundingClientRect() } catch (e) { r = null }
    cardDrag = {
      startX: ev.clientX,
      startY: ev.clientY,
      origLeft: r ? r.left : (parseFloat(card.style.left) || 0),
      origTop: r ? r.top : (parseFloat(card.style.top) || 0),
      w: (r && r.width) || 340,
      h: (r && r.height) || 220,
      moved: false,
      pid: ev.pointerId,
    }
    // 指针捕获：拖出卡片范围后 pointermove / pointerup 仍然派发给卡片，
    // 不依赖 onShield 的 target 判定（鼠标一离开卡片 target 就变成页面元素了）。
    try { if (card.setPointerCapture && ev.pointerId != null) card.setPointerCapture(ev.pointerId) } catch (e) { /* ignore */ }
    try { card.classList.add('_lps-dragging') } catch (e) { /* ignore */ }
    ev.preventDefault()
  }

  function onCardPointerMove(ev) {
    if (!cardDrag || !card) return
    var dx = ev.clientX - cardDrag.startX
    var dy = ev.clientY - cardDrag.startY
    if (!cardDrag.moved && dx * dx + dy * dy >= 9) cardDrag.moved = true
    if (!cardDrag.moved) return
    var vp = viewportBox()
    var m = 8
    var left = clampNum(cardDrag.origLeft + dx, m, Math.max(m, vp.w - cardDrag.w - m))
    var top = clampNum(cardDrag.origTop + dy, m, Math.max(m, vp.h - cardDrag.h - m))
    applyPos(card, left, top)
    ev.preventDefault()
  }

  function onCardPointerUp() {
    if (!cardDrag) return
    var moved = cardDrag.moved
    var pid = cardDrag.pid
    cardDrag = null
    if (moved) dragSuppressOnce = true
    if (card) {
      try { if (card.releasePointerCapture && pid != null) card.releasePointerCapture(pid) } catch (e) { /* ignore */ }
      try { card.classList.remove('_lps-dragging') } catch (e) { /* ignore */ }
      if (moved) writePos(parseFloat(card.style.left) || 0, parseFloat(card.style.top) || 0)
    }
  }

  function onCardClick(ev) {
    if (!card) return
    // 拖完松手补的那一次 click 不该触发按钮
    if (dragSuppressOnce) { dragSuppressOnce = false; return }
    var t = ev.target
    if (!t || !t.closest) return
    var hit = t.closest('._lps-card')
    if (!hit || hit !== card) return
    var act = t.closest('[data-act]')
    if (!act) return
    var fn = cardActions && cardActions[act.getAttribute('data-act')]
    if (fn) fn()
  }

  /** 卡片 / toast 上的一切指针事件都不许外传（捕获阶段最外层先截）。 */
  function shieldTarget(t) {
    if (!t || !t.closest) return null
    try {
      return t.closest('._lps-card') || t.closest('._lps-toast')
    } catch (e) { return null }
  }

  function onShield(ev) {
    // 遮罩框选中：卡片/toast 上的事件一律放行给遮罩。
    // 遮罩 z-index 已经高于卡片，正常情况 target 不会是卡片；
    // 但卡片若被浏览器提升为合成层（transform/will-change），命中测试仍可能落到卡片上，
    // 所以这里再兜一层，不能只靠 z-index。
    if (state.active) return
    // 拖动中即使指针已经移出卡片（target 变成页面元素），也继续接管 move/up，
    // 这样不依赖 setPointerCapture 是否真的生效。
    var dragging = !!cardDrag && (ev.type === 'pointermove' || ev.type === 'pointerup' || ev.type === 'pointercancel')
    if (!dragging && !shieldTarget(ev.target)) return
    // 一次真实点击一定从 pointerdown 开始；浏览器在拖拽后补发的 click 没有 pointerdown，
    // 所以在这里清标记，就能只吃掉「补发的那一个 click」。
    if (ev.type === 'pointerdown') dragSuppressOnce = false
    if (ev.type === 'pointerdown') {
      onCardPointerDown(ev)
    } else if (ev.type === 'pointermove') {
      onCardPointerMove(ev)
    } else if (ev.type === 'pointerup' || ev.type === 'pointercancel') {
      onCardPointerUp(ev)
    } else if (ev.type === 'click') {
      onCardClick(ev)
    }
    // 一律就地截断：遮罩长按检测、页面的其它 document 捕获监听、鲸鱼挂件都收不到。
    // 鲸鱼的 onDocClickStopper / onDocPointerDown 挂在 **document 捕获**、
    // 判定方式是 isWhaleHit() 的**几何命中**（拿 img 的 rect + 透明像素画布算，完全不看 e.target），
    // 卡片压在鲸鱼身上时它照样认为点在鲸鱼上 → 吞掉 click，表现就是「点关闭结果点到桌宠」。
    // 我们挂在 window 捕获，捕获路径 window → document → …，所以先于它执行，必须在这里挡住。
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation()
    ev.stopPropagation()
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
        return
      }
    } catch (e) { /* fall through */ }
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    } catch (e) { /* ignore */ }
  }

  var toastTimer = null
  var toastEl = null

  function toast(msg, ms) {
    ensureStyle()
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.className = '_lps-toast'
      ;(document.body || document.documentElement).appendChild(toastEl)
    }
    toastEl.textContent = msg
    toastEl.style.display = 'block'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.style.display = 'none'
    }, ms || 2000)
  }

  // ---------------- 安装 ----------------
  ensureStyle()
  // 预览卡 / toast 的事件隔离必须挂在 **window** 捕获阶段：
  // 捕获路径是 window → document → … → target，window 上先跑，
  // 才能抢在鲸鱼挂件（document 捕获 + 几何命中判定）和遮罩长按检测前面把它们截住。
  var SHIELD = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'mousedown', 'mouseup']
  for (var si = 0; si < SHIELD.length; si++) {
    window.addEventListener(SHIELD[si], onShield, true)
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('pointerup', onPointerUp, true)
  document.addEventListener('pointercancel', onPointerCancel, true)
  window.addEventListener('blur', function () { clearHold() })

  // ---------------- 拖放桥接（v1.11.0） ----------------
  // 保留原来的只观测诊断，并在「拖到输入框但 Chromium 把 Files 吞了」时改走粘贴通道。
  ;(function installDropBridge() {
    var lastOver = 0
    function tgt(ev) {
      var t = ev.target
      if (!t) return ''
      var cls = ''
      try { cls = (t.className && typeof t.className === 'string') ? t.className : '' } catch (e) { cls = '' }
      return String(t.tagName || '') + (cls ? '.' + cls.split(/\s+/).slice(0, 2).join('.') : '')
    }
    document.addEventListener('dragenter', function (ev) {
      if (dragActive) overComposer = overComposer || inComposer(ev.target, ev)
      diag('dragenter', { types: dtTypes(ev.dataTransfer), nfiles: dtFiles(ev.dataTransfer).length, at: tgt(ev), over: overComposer })
    }, true)
    document.addEventListener('dragover', function (ev) {
      if (dragActive) overComposer = overComposer || inComposer(ev.target, ev)
      var now = Date.now()
      if (now - lastOver < 400) return
      lastOver = now
      diag('dragover', { types: dtTypes(ev.dataTransfer), nfiles: dtFiles(ev.dataTransfer).length, at: tgt(ev) })
    }, true)
    function rescue(where, ev) {
      if (!dragActive || dropRescued) return
      // dragend 的 target 是拖源自己（我们的 div），靠拖拽终点坐标判断；
      // drop 的 target 是宿主容器，靠已经粘住的 overComposer 判断。
      var near = inComposer(ev && ev.target, ev)
      if (!overComposer && !near) return
      var file = (cardFile && cardFile.file) || null
      if (!file) return
      dropRescued = true
      var ok = pasteIntoComposer(file)
      if (ok) {
        try { if (ev && ev.preventDefault) ev.preventDefault() } catch (e) { /* ignore */ }
        // 静默兜底：拖拽被拦下时直接以粘贴插入，不再弹提示
      }
      diag('drop-rescue', { where: where, name: file.name, ok: ok, over: overComposer, near: near })
    }
    document.addEventListener('drop', function (ev) {
      var fs = dtFiles(ev.dataTransfer)
      var names = []
      for (var i = 0; i < fs.length && i < 3; i++) names.push((fs[i] && fs[i].name) || '?')
      diag('drop', { types: dtTypes(ev.dataTransfer), nfiles: fs.length, names: names.join(','), at: tgt(ev) })
      // 宿主拿到 Files 时它自己会摄取，我们不插手
      if (fs.length > 0) return
      if (dragActive) overComposer = overComposer || inComposer(ev.target, ev)
      rescue('drop', ev)
    }, true)
    window.addEventListener('dragend', function (ev) {
      diag('dragend', { types: dtTypes(ev.dataTransfer), nfiles: dtFiles(ev.dataTransfer).length, at: tgt(ev) })
      // drop 没落到输入框（或压根没触发 drop）时再兜一次
      rescue('dragend', null)
      dragActive = false
      overComposer = false
      dropRescued = false
    }, true)
  })()
})()
