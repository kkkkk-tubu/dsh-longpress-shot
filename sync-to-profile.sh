#!/usr/bin/env bash
# 把源码目录的 lib/ 同步进 desktop profile 里真正被加载的那份。
#
# 为什么需要这一步：宿主的 shot.js 路由按 SHOT_JS_CANDIDATES[0] = <包>/lib/shot.js 读取，
# 读的是 profile 里那份。workspace 与 profile 之间原本是硬链接，但 edit/write 会
# 「写临时文件再改名」，inode 换了，链接就断了 —— 之后改 workspace 不会反映到运行的包。
# 所以每次改完源码跑一次这个脚本。
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="${HOME}/.dsh/profiles/desktop/node_modules/dsh-longpress-shot"

if [ ! -d "$DST" ]; then
  echo "profile 里没有这个包：$DST" >&2
  exit 1
fi

same_file() {
  local a="$1" b="$2"
  [ -e "$b" ] || return 1
  [ "$(stat -c %d:%i "$a" 2>/dev/null)" = "$(stat -c %d:%i "$b" 2>/dev/null)" ]
}

sync_one() {
  local rel="$1"
  local a="$SRC/$rel" b="$DST/$rel"
  if [ ! -e "$a" ]; then
    echo "  跳过 $rel（源码里没有）"
    return 0
  fi
  if same_file "$a" "$b"; then
    echo "  $rel 已是同一文件（硬链接完好）"
  elif cp "$a" "$b"; then
    echo "  $rel 已复制"
  else
    echo "  失败 $rel" >&2
    return 1
  fi
}

rc=0
sync_one "lib/shot.js"     || rc=1
sync_one "lib/index.js"    || rc=1
sync_one "lib/capture.ps1" || rc=1
sync_one "package.json"    || rc=1

echo
echo "目标：$DST"
echo "  shot.js    $(wc -c < "$DST/lib/shot.js") bytes   $(date -r "$DST/lib/shot.js" '+%H:%M:%S')"
echo "  index.js   $(wc -c < "$DST/lib/index.js") bytes   $(date -r "$DST/lib/index.js" '+%H:%M:%S')"
echo "  capture.ps1 $(wc -c < "$DST/lib/capture.ps1") bytes   $(date -r "$DST/lib/capture.ps1" '+%H:%M:%S')"
echo
echo "shot.js 走 no-store，页面 Ctrl+R 刷新即生效；只有 index.js 变了才需要重启 DSH。"
exit $rc
