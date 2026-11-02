/**
 * selftest-row.mjs —— 校验注入行 DESKTOP_ROW_TEXT 本身
 *
 * 为什么需要它：注入行是一个「字符串拼出来的 IIFE」。拼错一个括号，浏览器
 * 会在解析期整段丢弃，连 try/catch 都进不去 —— 页面里表现为「插件完全没反应」，
 * 宿主端却全是 200，看起来一切正常。2026-10-26 就是这么挂的：
 * `then(apply)}` 后面又跟了一个 `}`，`new Function()` 报 missing ) after argument list。
 *
 * 跑：ELECTRON_RUN_AS_NODE=1 "E:/DSH/DeepSeek Harness.exe" selftest-row.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, 'lib', 'index.js'), 'utf8')

const SCRIPT_URL = '/dsh-longpress-shot/shot.js'
const VERSION_URL = '/dsh-longpress-shot/version'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')) }
}

// —— 1) 取出真实的 DESKTOP_ROW_TEXT 值（跟宿主运行时同一份字面量） ——
const start = SRC.indexOf('const DESKTOP_ROW_TEXT =')
const end = SRC.indexOf('\n\n', start)
ok('index.js 里找得到 DESKTOP_ROW_TEXT', start >= 0 && end > start)
const expr = SRC.slice(start, end).replace(/^const DESKTOP_ROW_TEXT\s*=\s*/, '')
const TEXT = eval(expr)

console.log('\n[1] 括号平衡 / 可解析')
ok('非空', typeof TEXT === 'string' && TEXT.length > 100, 'len=' + TEXT.length)
let parseErr = null
try { new Function(TEXT) } catch (e) { parseErr = e.message }
ok('new Function() 能通过（解析期无错）', parseErr === null, parseErr)
ok('以 IIFE 开头', TEXT.startsWith('(function(){'))
ok('以 IIFE 收尾', TEXT.endsWith('()'), 'tail=' + TEXT.slice(-6))

console.log('\n[2] 关键拼接点')
ok('拼进了 SCRIPT_URL', TEXT.includes('var S="' + SCRIPT_URL + '"'))
ok('拼进了 VERSION_URL', TEXT.includes('V="' + VERSION_URL + '"'))
ok('inside-try 的 ) 数量等于 ( 数量',
  (TEXT.match(/\(/g) || []).length === (TEXT.match(/\)/g) || []).length,
  '(' + (TEXT.match(/\(/g) || []).length + ' vs )' + (TEXT.match(/\)/g) || []).length)
ok('{ } 数量相等',
  (TEXT.match(/\{/g) || []).length === (TEXT.match(/\}/g) || []).length)

console.log('\n[3] 行为契约（在沙箱里跑一遍）')
// 造一个最小假环境，真正执行这段 IIFE，看它有没有把 script 挂上、有没有启动轮询。
// 注意：IIFE 整段包在 try{}catch(e){} 里，任何 ReferenceError 都会被静默吞掉，
// 所以「不抛异常」本身不构成证据 —— 必须逐项断言它真的干了活。
const created = []
const intervals = []
let hitFetch = 0
const sandbox = {}
sandbox.window = sandbox // IIFE 靠 window.__DSH_LONGPRESS_LOADER__ 做防重入
sandbox.document = {
  body: { appendChild: (n) => created.push(n) },
  head: null,
  documentElement: null,
  createElement: () => ({ _src: '', onerror: null }),
}
sandbox.fetch = () => { hitFetch++; return new Promise(() => {}) }
sandbox.location = { reload: () => {} }
sandbox.setInterval = (fn, ms) => { intervals.push(ms) }
sandbox.setTimeout = (fn, ms) => {}
sandbox.Date = Date
const vm = await import('node:vm')
let runErr = null
try { vm.runInNewContext(TEXT, sandbox) } catch (e) { runErr = e.message }
ok('IIFE 执行不抛异常', runErr === null, runErr)
ok('（防御性）没有被 catch 吞掉 —— 装载标记已设',
  sandbox.__DSH_LONGPRESS_LOADER__ === 1,
  'loader=' + sandbox.__DSH_LONGPRESS_LOADER__)
ok('挂了 1 个 script 节点', created.length === 1, 'got ' + created.length)
ok('script.src 指向 shot.js 并带 ?v=', !!created[0] && /shot\.js\?v=\d+$/.test(created[0].src || ''), created[0] && created[0].src)
ok('script.onerror 已挂（加载失败静默）', !!created[0] && typeof created[0].onerror === 'function')
ok('注册了 5000ms 轮询', intervals.includes(5000), JSON.stringify(intervals))
ok('立即 probe 了一次', hitFetch >= 1, 'fetch calls=' + hitFetch)
ok('设了 __DSH_LONGPRESS_LOADER__ 防重入', sandbox.__DSH_LONGPRESS_LOADER__ === 1)

console.log('\n[4] 重入保护')
const created2before = created.length
try { vm.runInNewContext(TEXT, sandbox) } catch (e) { /* ignore */ }
ok('第二次执行不再挂 script', created.length === created2before, 'got ' + created.length)

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + '  (' + pass + ' passed)')
process.exit(fail === 0 ? 0 : 1)
