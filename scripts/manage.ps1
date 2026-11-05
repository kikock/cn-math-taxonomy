# ==============================================================================
# 中小学·高中知识图谱 (cn-math-taxonomy)
# 源码更新、群晖 NAS 发布、Git 提交推送与科大讯飞 T30 平板 APK 打包综合引擎
# ==============================================================================
$ErrorActionPreference = "Stop"

# 定位项目根目录
$RootDir = $env:CNM_ROOT_DIR
if (-not $RootDir) {
    if ($PSScriptRoot) {
        $RootDir = (Resolve-Path "$PSScriptRoot\..").Path
    } else {
        $RootDir = (Get-Location).Path
    }
}
Set-Location $RootDir

# 环境路径配置
$NasWebDir      = "\\192.168.66.66\web"
$UpstreamUrl    = "https://github.com/xiaoyang111222/cn-math-taxonomy.git"
$JavaHomeCand   = "D:\developmentTool\MiseManager\mise\data\installs\java\21.0.12+101.0.LTS"
$AndroidSdkCand = "$env:LOCALAPPDATA\Android\Sdk"
$ApkOutputName  = "cn-math-taxonomy-pad-t30-v1.0.0.apk"

function Write-Step($msg) {
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host " $msg" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
}

function Ensure-BuildEnv {
    if (Test-Path $JavaHomeCand) {
        $env:JAVA_HOME = $JavaHomeCand
        $env:PATH = "$JavaHomeCand\bin;$env:PATH"
    }
    if (Test-Path $AndroidSdkCand) {
        $env:ANDROID_HOME = $AndroidSdkCand
        $env:ANDROID_SDK_ROOT = $AndroidSdkCand
    }
    if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME\bin\java.exe")) {
        throw "未找到有效的 JDK 环境，请检查 JAVA_HOME 配置（当前值: $env:JAVA_HOME）。"
    }
    if (-not $env:ANDROID_HOME -or -not (Test-Path $env:ANDROID_HOME)) {
        throw "未找到有效的 Android SDK 目录，请检查 ANDROID_HOME 配置（当前值: $env:ANDROID_HOME）。"
    }
}

# ------------------------------------------------------------------------------
# 功能 1：拉取远程最新源码 (origin + upstream 零冲突外挂重挂载机制)
# ------------------------------------------------------------------------------
function Invoke-GitUpdate {
    Write-Step "正在安全同步远程源码与上游题库（防覆盖/零冲突模式）..."
    Set-Location $RootDir

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    # 1. 仅还原上游入口文件的自动注入钩子（我们自己的独立文件 assets/pad-t30.css, platform.js, scratchpad.js 等完全保留）
    $entryFiles = @("index.html", "explore/index.html", "diagnose/index.html", "children/index.html", "children/history.html", "sw.js", "package.json")
    Write-Host "-> [1/4] 临时卸下上游入口文件的挂载钩子，确保拉取零冲突..." -ForegroundColor Gray
    git checkout -- $entryFiles

    # 2. 检查是否还有其他已跟踪文件的未提交修改（绝不加 -u，防止把新增的独立平板文件塞进 stash）
    $dirtyTracked = git diff --name-only
    $stashed = $false
    if ($dirtyTracked) {
        Write-Host "检测到其他已跟踪文件有未提交修改，正在执行 git stash 保护..." -ForegroundColor Yellow
        git stash push -m "auto-stash-tracked-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        $stashed = $true
    }

    try {
        $remotes = git remote
        if ($remotes -notcontains "upstream") {
            git remote add upstream $UpstreamUrl
        }

        Write-Host "-> [2/4] 正在拉取个人 Fork 仓库 (origin/main)..." -ForegroundColor Gray
        git fetch origin main
        if ($LASTEXITCODE -eq 0) {
            git merge origin/main --no-edit -X theirs
            Write-Host "origin/main 同步完成。" -ForegroundColor Green
        }

        Write-Host "-> [3/4] 正在检查上游源仓库 ($UpstreamUrl) 是否有新题库或新功能..." -ForegroundColor Gray
        git fetch upstream main
        if ($LASTEXITCODE -eq 0) {
            $behind = git rev-list --count HEAD..upstream/main
            if ([int]$behind -gt 0) {
                Write-Host "发现上游源仓库有 $behind 个新提交，正在执行无冲突合并 (upstream/main)..." -ForegroundColor Yellow
                # 若入口文件（如 index.html / sw.js）与上游冲突，优先采用上游最新版本，随后由 inject-pad.js 重新挂载平板脚本
                git merge upstream/main --no-edit -X theirs
                if ($LASTEXITCODE -ne 0) {
                    throw "合并 upstream/main 失败，请检查 git status。"
                }
                Write-Host "成功合并上游最新题库与功能！" -ForegroundColor Green
            } else {
                Write-Host "上游源仓库无新增提交，当前题库已是最新。" -ForegroundColor Green
            }
        }
    } finally {
        if ($stashed) {
            Write-Host "正在恢复之前暂存的已跟踪文件修改 (git stash pop)..." -ForegroundColor Yellow
            git stash pop
        }
        Write-Host "-> [4/4] 正在执行 scripts/inject-pad.js 自动重新挂载科大讯飞 T30 平板外挂组件..." -ForegroundColor Gray
        node "$RootDir\scripts\inject-pad.js"
        $ErrorActionPreference = $prevEap
    }
}

# ------------------------------------------------------------------------------
# 功能 2：运行全量自动化测试套件
# ------------------------------------------------------------------------------
function Invoke-UnitTests {
    Write-Step "正在运行全量自动化单元测试 (146 项断言)..."
    Set-Location $RootDir
    node "$RootDir\scripts\inject-pad.js" | Out-Null
    npm test
    if ($LASTEXITCODE -ne 0) {
        throw "单元测试未通过！已中止后续构建与发布流程。"
    }
    Write-Host "全部单元测试验证通过！" -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 功能 3：构建科大讯飞 T30 平板 Android Release APK
# ------------------------------------------------------------------------------
function Invoke-BuildApk {
    Write-Step "正在构建科大讯飞 T30 平板 Android 离线 APK..."
    Set-Location $RootDir
    Ensure-BuildEnv

    if (-not (Test-Path "$RootDir\node_modules\@capacitor\core")) {
        Write-Host "首次运行，正在安装 Capacitor 依赖..." -ForegroundColor Yellow
        npm install
    }

    Write-Host "-> [1/3] 抽取并压缩离线静态资产与 10 大学科题库 (www/)..." -ForegroundColor Gray
    node scripts/build-www.js
    if ($LASTEXITCODE -ne 0) { throw "build-www.js 执行失败！" }

    Write-Host "-> [2/3] 同步资产至 Capacitor Android 原生工程..." -ForegroundColor Gray
    if (-not (Test-Path "$RootDir\android")) {
        npx cap add android
    } else {
        npx cap sync android
    }
    if ($LASTEXITCODE -ne 0) { throw "Capacitor 同步失败！" }

    Write-Host "-> [3/3] 执行 Gradle Release 编译与 V1/V2/V3 签名..." -ForegroundColor Gray
    Set-Location "$RootDir\android"
    .\gradlew.bat assembleRelease --no-daemon
    if ($LASTEXITCODE -ne 0) {
        Set-Location $RootDir
        throw "Gradle 编译 Release APK 失败！"
    }
    Set-Location $RootDir

    $apkSrc = "$RootDir\android\app\build\outputs\apk\release\app-release.apk"
    if (-not (Test-Path $apkSrc)) {
        throw "未找到编译输出的 APK 文件: $apkSrc"
    }

    $distDir = "$RootDir\dist"
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    $apkDest = "$distDir\$ApkOutputName"
    $apkUniversal = "$distDir\cn-math-taxonomy-v1.0.0.apk"
    Copy-Item -Path $apkSrc -Destination $apkDest -Force
    Copy-Item -Path $apkSrc -Destination $apkUniversal -Force

    $sizeMb = [Math]::Round((Get-Item $apkUniversal).Length / 1MB, 2)
    Write-Host "`n[成功] 安卓全端通用版 APK (手机 + 平板自适应) 打包完成！" -ForegroundColor Green
    Write-Host "  通用版安装包 : $apkUniversal" -ForegroundColor Yellow
    Write-Host "  平板兼容包名 : $apkDest" -ForegroundColor Gray
    Write-Host "  安装包体积   : $sizeMb MB (内含 10 大学科离线题库、悬浮草稿本与数学小键盘)" -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------
# 功能 4：发布静态站点到群晖 NAS (\\192.168.66.66\web)
# ------------------------------------------------------------------------------
function Invoke-DeployNas {
    Write-Step "正在增量发布静态站点到群晖 NAS ($NasWebDir)..."
    Set-Location $RootDir

    if (-not (Test-Path $NasWebDir)) {
        Write-Warning "无法连接到群晖共享目录: $NasWebDir。请确认群晖已开机且 SMB 共享已开启。"
        return
    }
    Write-Host "群晖 NAS 连接正常: $NasWebDir" -ForegroundColor Green

    $excludeDirs = @(".git", ".github", ".idea", "scripts", "tests", "android", "www", "dist", "node_modules", "screenshots", "_qbatches", "_second_pass")
    $excludeFiles = @(".gitignore", "*.apk", "*.aab", "*.jks", "*.keystore", "*.ps1", "*.bat", "package.json", "package-lock.json", "capacitor.config.json")

    $robocopyArgs = @(
        $RootDir,
        $NasWebDir,
        "/E",
        "/XO",
        "/XD"
    ) + $excludeDirs + @("/XF") + $excludeFiles + @("/R:2", "/W:2", "/NP")

    $proc = Start-Process -FilePath "robocopy.exe" -ArgumentList $robocopyArgs -NoNewWindow -Wait -PassThru
    if ($proc.ExitCode -lt 8) {
        $apkLocal = "$RootDir\dist\$ApkOutputName"
        if (Test-Path $apkLocal) {
            $nasApkDir = "$NasWebDir\apk"
            New-Item -ItemType Directory -Force -Path $nasApkDir | Out-Null
            Copy-Item -Path $apkLocal -Destination "$nasApkDir\cn-math-taxonomy.apk" -Force
            Copy-Item -Path $apkLocal -Destination "$nasApkDir\cn-math-taxonomy-v1.0.0.apk" -Force
            Copy-Item -Path $apkLocal -Destination "$nasApkDir\$ApkOutputName" -Force
            Write-Host "已同步手机/平板通用 APK 至群晖直链: http://192.168.66.66/apk/cn-math-taxonomy.apk" -ForegroundColor Cyan
        }
        Write-Host "群晖 NAS 静态文件增量发布成功！(Robocopy ExitCode: $($proc.ExitCode))" -ForegroundColor Green
        Write-Host "访问地址: http://192.168.66.66/" -ForegroundColor Yellow
    } else {
        throw "Robocopy 同步异常，返回码: $($proc.ExitCode)"
    }
}

# ------------------------------------------------------------------------------
# 功能 5：提交本地代码并推送到 GitHub (origin/main)
# ------------------------------------------------------------------------------
function Invoke-GitPublish([string]$CommitMsg) {
    Write-Step "正在提交并推送源码变更到 GitHub (origin/main)..."
    Set-Location $RootDir

    $status = git status --porcelain
    if (-not $status) {
        Write-Host "当前工作区没有需要提交的变更。" -ForegroundColor Green
        return
    }

    Write-Host "当前变更文件列表：" -ForegroundColor Yellow
    git status -s

    if (-not $CommitMsg) {
        $CommitMsg = Read-Host "`n请输入 Git 提交说明 (直接回车默认使用 'feat(pad): 更新知识图谱与科大讯飞T30平板适配')"
        if ([string]::IsNullOrWhiteSpace($CommitMsg)) {
            $CommitMsg = "feat(pad): 更新知识图谱与科大讯飞T30平板适配"
        }
    }

    git add -A
    git commit -m $CommitMsg
    if ($LASTEXITCODE -ne 0) { throw "git commit 失败！" }

    git push origin main
    if ($LASTEXITCODE -ne 0) { throw "git push origin main 失败！" }
    Write-Host "源码已成功推送至 GitHub 远程仓库！" -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 功能 6：通过 ADB 或 MTP 文件传输一键推送/安装 APK 到科大讯飞 T30 平板
# ------------------------------------------------------------------------------
function Copy-ToMtpFolder($mtpFolder, [string]$localFilePath, [string]$fileName) {
    # 若目标 MTP 目录中已存在同名文件，先调用 InvokeVerb("delete") 或移入回收站避免弹窗阻塞
    $existing = $mtpFolder.Items() | Where-Object { $_.Name -eq $fileName } | Select-Object -First 1
    if ($existing) {
        try {
            $existing.InvokeVerb("delete")
            Start-Sleep -Milliseconds 600
        } catch {}
    }
    # 16 = Yes to All, 4 = 不显示进度对话框
    $mtpFolder.CopyHere($localFilePath, 20)
    # 轮询等待 MTP 传输落盘（最多等待 10 秒）
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $copied = $mtpFolder.Items() | Where-Object { $_.Name -eq $fileName } | Select-Object -First 1
        if ($copied) { return $true }
    }
    return $false
}

function Invoke-AdbInstall {
    Write-Step "正在检测已连接的科大讯飞 T30 平板设备 (ADB / MTP 双模推送)..."
    Ensure-BuildEnv
    $apkPath = "$RootDir\dist\$ApkOutputName"
    if (-not (Test-Path $apkPath)) {
        Write-Host "尚未找到已打包的 APK，先自动触发打包..." -ForegroundColor Yellow
        Invoke-BuildApk
    }

    # 模式 A：优先检查是否开启了 ADB 调试
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $adbExe = "$env:ANDROID_HOME\platform-tools\adb.exe"
    if (Test-Path $adbExe) {
        $adbOut = & $adbExe devices
        $hasAdbDevice = ($adbOut | Select-String -Pattern "\tdevice$").Count -gt 0
        if ($hasAdbDevice) {
            Write-Host "-> 检测到 ADB 在线设备，正在执行 adb install -r 静默安装..." -ForegroundColor Cyan
            & $adbExe install -r $apkPath
            if ($LASTEXITCODE -eq 0) {
                $ErrorActionPreference = $prevEap
                Write-Host "[成功] APK 已通过 ADB 直接安装至科大讯飞平板！" -ForegroundColor Green
                return
            }
        }
    }
    $ErrorActionPreference = $prevEap

    # 模式 B：科大讯飞学习机默认锁定 ADB，采用 Windows Shell MTP 协议直推平板存储
    Write-Host "-> 正在通过 USB MTP 协议检索「科大讯飞AI学习机」..." -ForegroundColor Cyan
    $shell = New-Object -ComObject Shell.Application
    $dev = $shell.NameSpace(17).Items() | Where-Object { $_.Name -match '科大讯飞|学习机|T30|iFly' } | Select-Object -First 1
    if (-not $dev) {
        Write-Warning "未检测到已连接的「科大讯飞AI学习机」。请确认平板 USB 连接模式已选择「传输文件 (MTP)」。"
        return
    }

    Write-Host "-> 已连接设备: $($dev.Name)" -ForegroundColor Green
    $storage = $dev.GetFolder().Items() | Select-Object -First 1
    if (-not $storage) {
        Write-Warning "检测到「$($dev.Name)」，但无法读取内部共享存储空间。请在平板屏幕上解锁并确认允许「文件传输」。"
        return
    }

    $rootFolder = $storage.GetFolder()
    Write-Host "-> 正在将 $ApkOutputName 推送至「$($dev.Name)\$($storage.Name)」根目录..." -ForegroundColor Gray
    $okRoot = Copy-ToMtpFolder $rootFolder $apkPath $ApkOutputName

    $dlItem = $rootFolder.Items() | Where-Object { $_.Name -eq 'Download' } | Select-Object -First 1
    $okDl = $false
    if ($dlItem) {
        Write-Host "-> 正在将 $ApkOutputName 推送至「$($dev.Name)\$($storage.Name)\Download」目录..." -ForegroundColor Gray
        $okDl = Copy-ToMtpFolder $dlItem.GetFolder() $apkPath $ApkOutputName
    }

    if ($okRoot -or $okDl) {
        Write-Host "`n[成功] APK 安装包已成功传输至「科大讯飞AI学习机」内部存储！" -ForegroundColor Green
        Write-Host "  平板路径 1 : 内部共享存储空间\$ApkOutputName" -ForegroundColor Yellow
        if ($okDl) {
            Write-Host "  平板路径 2 : 内部共享存储空间\Download\$ApkOutputName" -ForegroundColor Yellow
        }
        Write-Host "  下一步操作 : 请在平板上打开「文件管理」->「安装包 (或内部存储/Download)」，点击 $ApkOutputName 即可完成安装！" -ForegroundColor Cyan
    } else {
        Write-Warning "MTP 传输未能确认完成，请检查平板屏幕是否处于解锁状态。"
    }
}

# ------------------------------------------------------------------------------
# 命令行参数直通模式
# ------------------------------------------------------------------------------
$rawCli = if ($env:CNM_CLI_ARGS) { $env:CNM_CLI_ARGS.Trim() } elseif ($args.Count -gt 0) { ($args -join " ").Trim() } else { "" }
if ($rawCli) {
    $parts = $rawCli -split '\s+', 2
    $cmd = $parts[0].ToLower()
    $restArg = if ($parts.Count -gt 1) { $parts[1].Trim('"') } else { "" }
    switch ($cmd) {
        "all" {
            Invoke-GitUpdate
            Invoke-UnitTests
            Invoke-BuildApk
            Invoke-DeployNas
        }
        "apk"    { Invoke-BuildApk }
        "update" { Invoke-GitUpdate }
        "nas"    { Invoke-DeployNas }
        "test"   { Invoke-UnitTests }
        "git"    { Invoke-GitPublish $restArg }
        "adb"    { Invoke-AdbInstall }
        default  {
            Write-Host "未知参数: $cmd" -ForegroundColor Red
            Write-Host "支持的参数: all | apk | update | nas | test | git | adb" -ForegroundColor Yellow
            exit 1
        }
    }
    exit 0
}

# ------------------------------------------------------------------------------
# 交互式菜单模式 (双击运行)
# ------------------------------------------------------------------------------
while ($true) {
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "   中小学·高中知识图谱 (科大讯飞 T30 平板版) 构建发布中心" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "  [1] 一键全流程（拉取最新源码 -> 跑单测 -> 打包 APK -> 发布群晖 NAS）" -ForegroundColor Yellow
    Write-Host "  [2] 仅打包生成科大讯飞 T30 安卓安装包 (dist\$ApkOutputName)"
    Write-Host "  [3] 仅拉取远程最新源码与题库 (Git Pull Origin & Upstream)"
    Write-Host "  [4] 仅同步发布静态网页到群晖 NAS ($NasWebDir)"
    Write-Host "  [5] 提交本地修改并推送到 GitHub (Git Commit & Push)"
    Write-Host "  [6] 运行全量自动化单元测试 (146 项断言校验)"
    Write-Host "  [7] 一键推送/安装 APK 到已连接的科大讯飞 T30 平板 (MTP / ADB 双模)"
    Write-Host "  [0] 退出脚本"
    Write-Host "========================================================" -ForegroundColor Cyan

    $choice = Read-Host "请输入操作序号 [0-7]"
    try {
        switch ($choice.Trim()) {
            "1" {
                Invoke-GitUpdate
                Invoke-UnitTests
                Invoke-BuildApk
                Invoke-DeployNas
            }
            "2" {
                Invoke-BuildApk
            }
            "3" {
                Invoke-GitUpdate
            }
            "4" {
                Invoke-DeployNas
            }
            "5" {
                Invoke-GitPublish ""
            }
            "6" {
                Invoke-UnitTests
            }
            "7" {
                if (Test-Path "$RootDir\dist") {
                    Invoke-Item "$RootDir\dist"
                }
                Invoke-AdbInstall
            }
            "0" {
                Write-Host "已退出。" -ForegroundColor Gray
                break
            }
            default {
                Write-Warning "无效的选项，请输入 0 到 7 之间的数字。"
            }
        }
    } catch {
        Write-Host "`n[执行出错] $($_.Exception.Message)" -ForegroundColor Red
    }
    Write-Host ""
    Read-Host "按回车键返回主菜单..." | Out-Null
}

