<#
  install.ps1 —— 把「QQ 语音识别」装进 Coopanion 的扩展目录。

  做的事（只动 Coopanion 的 data\extensions）：
    1. 复制本包到 <data>\extensions\vendor\cortico-world-qq-voice
    2. 在 <data>\extensions\package.json 的 dependencies 里加 link: 依赖（先备份成 .bak）
    3. 在 <data>\extensions\node_modules\ 建同名 junction
  不做：不改主程序、不写注册表、不联网、不安装 Python 依赖。

  用法：
    install.cmd             安装（然后重启 Coopanion，在 World 总览里启用「QQ 语音识别」）
    install.cmd uninstall   卸载
    powershell -File install.ps1 -DataDir "D:\coopa\Coopanion\data"   # 手动指定数据目录
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Action = 'install',
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
$NAME = 'cortico-world-qq-voice'

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

# Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM；Cortico 用 JSON.parse
# 读 package.json，BOM 会让它启动即崩。这里统一写无 BOM 的 UTF-8。
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Test-Data([string]$dir) {
  if (-not $dir) { return $false }
  foreach ($m in 'home', 'logs', 'extensions', 'pet-window') {
    if (Test-Path -LiteralPath (Join-Path $dir $m)) { return $true }
  }
  return $false
}

function Find-Data {
  $record = Join-Path $env:LOCALAPPDATA 'Coopanion\data-location.json'
  if (Test-Path -LiteralPath $record) {
    try {
      $json = Get-Content -LiteralPath $record -Raw -Encoding UTF8 | ConvertFrom-Json
      if (Test-Data $json.data) { return $json.data }
      $beside = Join-Path $json.program 'data'
      if (Test-Data $beside) { return $beside }
    } catch { }
  }
  $exe = Get-Process -Name 'Coopanion' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path
  if ($exe) {
    $beside = Join-Path (Split-Path -Parent $exe) 'data'
    if (Test-Data $beside) { return $beside }
  }
  foreach ($root in @("$env:APPDATA\Coopanion", "$env:LOCALAPPDATA\Coopanion")) {
    if (Test-Data $root) { return $root }
  }
  return $null
}

$data = if ($DataDir) { $DataDir } else { Find-Data }
if (-not $data -or -not (Test-Path -LiteralPath $data)) {
  Say '没找到 Coopanion 的数据目录。用 -DataDir 手动指定，例如：' 'Red'
  Say '  powershell -ExecutionPolicy Bypass -File install.ps1 -DataDir "D:\coopa\Coopanion\data"' 'Yellow'
  exit 2
}
$extensions = Join-Path $data 'extensions'
$pkgJson = Join-Path $extensions 'package.json'
$nodeModules = Join-Path $extensions 'node_modules'
$vendorTarget = Join-Path (Join-Path $extensions 'vendor') $NAME
$linkPath = Join-Path $nodeModules $NAME
Say ('数据目录：' + $data) 'DarkCyan'

if ($Action -eq 'uninstall') {
  if (Test-Path -LiteralPath $pkgJson) {
    try {
      $pkg = Get-Content -LiteralPath $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties[$NAME]) {
        Copy-Item $pkgJson ($pkgJson + '.bak') -Force
        $pkg.dependencies.PSObject.Properties.Remove($NAME)
        $pkg | ConvertTo-Json -Depth 20 | ForEach-Object { Write-Utf8NoBom $pkgJson $_ }
        Say '已从 extensions\package.json 移除依赖（备份 .bak）。' 'Green'
      }
    } catch { Say ('改 package.json 失败：' + $_.Exception.Message) 'Yellow' }
  }
  if (Test-Path -LiteralPath $linkPath) {
    (Get-Item -LiteralPath $linkPath -Force).Delete()
    Say '已删除 node_modules 里的联接。' 'Green'
  }
  if (Test-Path -LiteralPath $vendorTarget) {
    Remove-Item -LiteralPath $vendorTarget -Recurse -Force
    Say '已删除 vendor 目录。' 'Green'
  }
  Say '重启 Coopanion 生效。' 'DarkCyan'
  exit 0
}

if (-not (Test-Path -LiteralPath $extensions)) {
  Say ('扩展目录不存在：' + $extensions + '（先启动一次 Coopanion）') 'Red'
  exit 3
}
$source = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) {
  Say '没找到本包的 package.json，请把 install.cmd 和 src\ 放在同一个包目录里。' 'Red'
  exit 4
}

$vendorRoot = Split-Path -Parent $vendorTarget
if (-not (Test-Path -LiteralPath $vendorRoot)) { New-Item -ItemType Directory -Force -Path $vendorRoot | Out-Null }
if (Test-Path -LiteralPath $vendorTarget) { Remove-Item -LiteralPath $vendorTarget -Recurse -Force }
New-Item -ItemType Directory -Force -Path $vendorTarget | Out-Null
foreach ($item in 'package.json', 'README.md', 'LICENSE', 'ENV_PROMPT.md', 'asr_server.py', 'src', 'test') {
  $from = Join-Path $source $item
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $vendorTarget -Recurse -Force }
}
Say ('已复制到：' + $vendorTarget) 'Green'

try {
  $pkg = if (Test-Path -LiteralPath $pkgJson) { Get-Content -LiteralPath $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
  if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
  $spec = 'link:vendor/' + $NAME
  if ($pkg.dependencies.PSObject.Properties[$NAME]) {
    $pkg.dependencies.$NAME = $spec
  } else {
    $pkg.dependencies | Add-Member -NotePropertyName $NAME -NotePropertyValue $spec -Force
  }
  if (Test-Path -LiteralPath $pkgJson) { Copy-Item $pkgJson ($pkgJson + '.bak') -Force }
  $pkg | ConvertTo-Json -Depth 20 | ForEach-Object { Write-Utf8NoBom $pkgJson $_ }
  Say ('已在 extensions\package.json 里登记：' + $NAME + ' = ' + $spec) 'Green'
} catch {
  Say ('改 package.json 失败：' + $_.Exception.Message) 'Red'
  exit 5
}

if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null }
if (Test-Path -LiteralPath $linkPath) { (Get-Item -LiteralPath $linkPath -Force).Delete() }
New-Item -ItemType Junction -Path $linkPath -Target $vendorTarget | Out-Null
Say ('已建联接：' + $linkPath + '  →  ' + $vendorTarget) 'Green'

# 只提示，不替用户装 Python 依赖。
$python = Join-Path $extensions 'venv_vox\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  Say '提示：没找到 data\extensions\venv_vox\Scripts\python.exe；安装后请在插件配置里填 Python 路径。' 'Yellow'
}
$model = Join-Path $extensions 'vendor\asr-model\sherpa-onnx-sense-voice'
if (-not (Test-Path -LiteralPath $model)) {
  Say '提示：没找到 data\extensions\vendor\asr-model\sherpa-onnx-sense-voice；安装后请在插件配置里填模型目录。' 'Yellow'
}

Say ''
Say '装好了。接下来：' 'DarkCyan'
Say '  1. 完全退出并重启 Coopanion（不是关窗口，是退出程序）；' 'Gray'
Say '  2. 打开「World 总览」，启用「QQ 语音识别」；' 'Gray'
Say '  3. 在它的配置里填 NapCat Token（WS 服务端的 access token）；' 'Gray'
Say '  4. 在 QQ 里发一条语音，bot 应当先调用 qq_voice_transcribe 再回应。' 'Gray'
exit 0
