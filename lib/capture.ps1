<#
  capture.ps1 — 抓「DSH 主窗口客户区」，按比例裁剪，存 PNG，写剪贴板。

  由 dsh-longpress-shot 宿主半区以子进程调用。stdout 只输出一行 JSON。

  窗口定位策略（不靠标题硬匹配）：
    从 -AncestorPid（宿主 node 进程自身 PID）向上走父进程链，
    在祖先进程里找「可见、非最小化、有标题」的顶层窗口，
    取标题最像 DSH 的那个。这样无论标题随会话变化都能命中。

  裁剪用【比例】而不是像素：
    -CropX/-CropY/-CropW/-CropH ∈ [0,1]，相对窗口客户区。
    前端只需给出选区占视口的比例，宿主侧用客户区物理像素去乘，
    彻底绕开 DPI 缩放换算。
#>
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$AncestorPid = 0,
  [double]$CropX = 0,
  [double]$CropY = 0,
  [double]$CropW = 1,
  [double]$CropH = 1,
  [int]$Clipboard = 1,
  [string]$PreferredTitle = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('DshShotW32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshShotW32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  // 返回值必须是 bool：之前写成 IntPtr，实测调用不生效（客户区仍是虚拟化的 1279x821）。
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string name);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
}
'@
}

# per-monitor v2（-4）：此后所有坐标都是物理像素
try { [void][DshShotW32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][DshShotW32]::SetProcessDPIAware() } catch {} }

function Get-Title([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 1024
  [void][DshShotW32]::GetWindowTextW($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Exit-Json($obj) {
  $obj | ConvertTo-Json -Compress
  exit 0
}

# ---------- 1) 祖先进程集合 ----------
$ancestors = New-Object 'System.Collections.Generic.HashSet[int]'
if ($AncestorPid -gt 0) {
  $cur = $AncestorPid
  for ($i = 0; $i -lt 10 -and $cur -gt 0; $i++) {
    [void]$ancestors.Add($cur)
    try {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop
      if (-not $p) { break }
      $cur = [int]$p.ParentProcessId
    } catch { break }
  }
}
if ($ancestors.Count -eq 0) { [void]$ancestors.Add($PID) }

# ---------- 2) 在祖先进程里找目标窗口 ----------
$candidates = New-Object System.Collections.ArrayList
$cb = [DshShotW32+EnumProc]{
  param($h, $l)
  try {
    if (-not [DshShotW32]::IsWindowVisible($h)) { return $true }
    if ([DshShotW32]::IsIconic($h)) { return $true }
    $ownerPid = 0
    [void][DshShotW32]::GetWindowThreadProcessId($h, [ref]$ownerPid)
    if (-not $script:ancestors.Contains($ownerPid)) { return $true }
    $t = Get-Title $h
    if (-not $t) { return $true }
    $rc = New-Object DshShotW32+RECT
    if (-not [DshShotW32]::GetClientRect($h, [ref]$rc)) { return $true }
    $w = $rc.Right - $rc.Left; $hh = $rc.Bottom - $rc.Top
    if ($w -lt 200 -or $hh -lt 200) { return $true }
    [void]$script:candidates.Add([pscustomobject]@{ hwnd = $h; pid = $ownerPid; title = $t; w = $w; h = $hh })
  } catch {}
  return $true
}
[void][DshShotW32]::EnumWindows($cb, [IntPtr]::Zero)

if ($candidates.Count -eq 0) {
  Exit-Json @{ ok = $false; error = 'window-not-found'; ancestors = @($ancestors) }
}

$target = $null
if ($PreferredTitle) {
  $target = $candidates | Where-Object { $_.title -eq $PreferredTitle } | Select-Object -First 1
}
if (-not $target) {
  $target = $candidates | Where-Object { $_.title -like '*DeepSeek Harness*' } | Sort-Object { $_.w * $_.h } -Descending | Select-Object -First 1
}
if (-not $target) {
  $target = $candidates | Sort-Object { $_.w * $_.h } -Descending | Select-Object -First 1
}

$hwnd = $target.hwnd
$clipW = $target.w
$clipH = $target.h

$pt = New-Object DshShotW32+POINT
$pt.X = 0; $pt.Y = 0
[void][DshShotW32]::ClientToScreen($hwnd, [ref]$pt)

# ---------- 3) 比例 → 物理像素裁剪矩形（夹紧到客户区内） ----------
function Clamp([double]$v, [double]$lo, [double]$hi) { if ($v -lt $lo) { return $lo }; if ($v -gt $hi) { return $hi }; return $v }
$CropX = Clamp $CropX 0 1
$CropY = Clamp $CropY 0 1
$CropW = Clamp $CropW 0.01 1
$CropH = Clamp $CropH 0.01 1
if ($CropX + $CropW -gt 1) { $CropW = 1 - $CropX }
if ($CropY + $CropH -gt 1) { $CropH = 1 - $CropY }

$srcX = [int][math]::Floor($CropX * $clipW)
$srcY = [int][math]::Floor($CropY * $clipH)
$srcW = [int][math]::Ceiling($CropW * $clipW)
$srcH = [int][math]::Ceiling($CropH * $clipH)
if ($srcX + $srcW -gt $clipW) { $srcW = $clipW - $srcX }
if ($srcY + $srcH -gt $clipH) { $srcH = $clipH - $srcY }
if ($srcW -lt 1 -or $srcH -lt 1) {
  Exit-Json @{ ok = $false; error = 'empty-region'; clientW = $clipW; clientH = $clipH }
}

# ---------- 4) 抓屏并裁剪 ----------
$bmp = New-Object System.Drawing.Bitmap $clipW, $clipH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($pt.X, $pt.Y, 0, 0, (New-Object System.Drawing.Size $clipW, $clipH), [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally { $g.Dispose() }

  $crop = $bmp.Clone((New-Object System.Drawing.Rectangle $srcX, $srcY, $srcW, $srcH), $bmp.PixelFormat)
  try {
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $crop.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)

    $clipped = $false
    if ($Clipboard -eq 1) {
      try {
        $copy = New-Object System.Drawing.Bitmap $crop
        [System.Windows.Forms.Clipboard]::SetImage($copy)
        $clipped = $true
      } catch { $clipped = $false }
    }

    Exit-Json @{
      ok        = $true
      file      = $OutFile
      width     = $srcW
      height    = $srcH
      clientW   = $clipW
      clientH   = $clipH
      originX   = $pt.X
      originY   = $pt.Y
      bytes     = (Get-Item $OutFile).Length
      clipboard = $clipped
      title     = $target.title
      hwnd      = "$hwnd"
    }
  } finally { $crop.Dispose() }
} catch {
  Exit-Json @{ ok = $false; error = $_.Exception.Message }
} finally {
  $bmp.Dispose()
}
