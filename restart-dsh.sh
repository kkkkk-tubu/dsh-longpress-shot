#!/usr/bin/env bash
# 一键重启 DSH 桌面端（index.js / package.json / cordis.patch.yml 改动后必须做）
# 用法：bash restart-dsh.sh
# 原理：desktop-host（子进程）只在启动时把插件注入表收集一次，热改 index.js 进不了页面，
#       必须整棵进程树重建。杀壳层根进程即可，Electron 会带走全部子进程。
set -u
JSON="C:/Users/19906/.dsh/dsh-config-manager/running/desktop.json"
EXE_WIN='E:\DSH\DeepSeek Harness.exe'

readjson() { python -c "import json,io;d=json.load(io.open(r'$JSON',encoding='utf-8'));print(d['$1'])" 2>/dev/null; }

HOSTPID=$(readjson pid)
echo "desktop-host pid=$HOSTPID"
# 壳层根进程 = desktop-host 的父进程
ROOTPID=$(powershell -NoProfile -Command "
\$p = Get-CimInstance Win32_Process -Filter \"ProcessId=$HOSTPID\" -ErrorAction SilentlyContinue
if (\$p) { \$r = Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$p.ParentProcessId)\" -ErrorAction SilentlyContinue
  if (\$r -and \$r.Name -eq 'DeepSeek Harness.exe' -and -not \$r.CommandLine.Contains('--type=')) { \$r.ProcessId } else { \$p.ParentProcessId } }
" 2>/dev/null | tr -d '\r\n ')
echo "壳层根 pid=$ROOTPID"

taskkill //PID "$ROOTPID" 2>/dev/null || taskkill //PID "$HOSTPID" 2>/dev/null
for i in $(seq 1 25); do
  tasklist //FI "PID eq $ROOTPID" 2>/dev/null | grep -q " $ROOTPID " || { echo "旧实例已退出"; break; }
  sleep 1
done
sleep 2

echo "重新启动 $EXE_WIN"
cmd //c start "" "$EXE_WIN"
for i in $(seq 1 30); do
  NEWPORT=$(readjson port)
  NEWPID=$(readjson pid)
  if [ -n "$NEWPORT" ] && [ "$NEWPID" != "$HOSTPID" ] && curl -s -m 2 "http://127.0.0.1:$NEWPORT/dsh-longpress-shot/version" >/dev/null 2>&1; then
    echo "新实例 pid=$NEWPID port=$NEWPORT"
    curl -s "http://127.0.0.1:$NEWPORT/dsh-longpress-shot/version"; echo " <- /version (路由已注册)"
    exit 0
  fi
  sleep 2
done
echo "30 次探测内没等到 /version —— 打开 desktop.json 看状态"
exit 1
