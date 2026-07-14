param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('msi', 'nsis')]
    [string]$PackageKind,

    [Parameter(Mandatory = $true)]
    [string]$CandidateRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCandidateId,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCommitSha,

    [Parameter(Mandatory = $true)]
    [string]$Output
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-StringSha256([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Assert-CandidateFiles([string]$Root, [pscustomobject]$Candidate) {
    foreach ($identity in $Candidate.files) {
        if ($identity -notmatch '^((?:release|harness)/[^:]+):([0-9a-f]{64})$') {
            throw "Invalid candidate file identity: $identity"
        }
        $relativePath = $Matches[1].Replace('/', [IO.Path]::DirectorySeparatorChar)
        $expectedHash = $Matches[2].ToLowerInvariant()
        $path = Join-Path $Root $relativePath
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Candidate file is missing: $relativePath"
        }
        if ((Get-Sha256 $path) -ne $expectedHash) {
            throw "Candidate file digest mismatch: $relativePath"
        }
    }
}

function Get-CertPrepUninstallEntries {
    $registryRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    return @(
        foreach ($root in $registryRoots) {
            Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -eq 'Cert Prep' }
        }
    )
}

function Find-InstalledExecutable([object[]]$Entries) {
    $roots = [Collections.Generic.List[string]]::new()
    foreach ($entry in $Entries) {
        if ($entry.InstallLocation) { $roots.Add([string]$entry.InstallLocation) }
        if ($entry.DisplayIcon) {
            $displayPath = (([string]$entry.DisplayIcon).Split(',')[0]).Trim('"')
            if ($displayPath) { $roots.Add((Split-Path -Parent $displayPath)) }
        }
    }
    foreach ($fallback in @(
        (Join-Path $env:LOCALAPPDATA 'Cert Prep'),
        (Join-Path $env:ProgramFiles 'Cert Prep'),
        (Join-Path ${env:ProgramFiles(x86)} 'Cert Prep')
    )) {
        if ($fallback) { $roots.Add($fallback) }
    }
    foreach ($root in $roots | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $candidate = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -in @('cert-prep-desktop.exe', 'Cert Prep.exe') -or
                ($_.Extension -eq '.exe' -and $_.Name -notmatch '^unins|uninstall')
            } |
            Select-Object -First 1
        if ($candidate) { return $candidate }
    }
    throw 'Installed Cert Prep executable could not be located.'
}

function Get-DescendantProcesses([int]$RootPid) {
    $snapshot = @(Get-CimInstance Win32_Process)
    $owned = [Collections.Generic.HashSet[int]]::new()
    [void]$owned.Add($RootPid)
    do {
        $added = $false
        foreach ($process in $snapshot) {
            if ($owned.Contains([int]$process.ParentProcessId) -and
                -not $owned.Contains([int]$process.ProcessId)) {
                [void]$owned.Add([int]$process.ProcessId)
                $added = $true
            }
        }
    } while ($added)
    return @($snapshot | Where-Object { $owned.Contains([int]$_.ProcessId) })
}

function Wait-InstalledBackendHealth(
    [int]$AppPid,
    [string]$FreshAppData,
    [string]$ExpectedVersion,
    [string]$ExpectedPythonRuntime
) {
    $dataRoot = [IO.Path]::GetFullPath($FreshAppData)
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        $descendants = @(Get-DescendantProcesses $AppPid)
        $backendProcesses = @($descendants | Where-Object {
            $_.Name -eq 'cert-prep-backend.exe' -and $_.ExecutablePath
        })
        foreach ($backendProcess in $backendProcesses) {
            $backendPath = [IO.Path]::GetFullPath([string]$backendProcess.ExecutablePath)
            if (-not $backendPath.StartsWith(
                $dataRoot + [IO.Path]::DirectorySeparatorChar,
                [StringComparison]::OrdinalIgnoreCase
            )) {
                continue
            }
            $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess `
                ([int]$backendProcess.ProcessId) -ErrorAction SilentlyContinue)
            foreach ($listener in $listeners) {
                if ($listener.LocalAddress -notin @('127.0.0.1', '::1')) { continue }
                try {
                    $health = Invoke-RestMethod `
                        -Uri "http://127.0.0.1:$($listener.LocalPort)/health" `
                        -TimeoutSec 5
                    if ($health.status -eq 'ok' -and
                        $health.runtime_mode -eq 'packaged' -and
                        $health.version -eq $ExpectedVersion -and
                        ([string]$health.python_version).StartsWith(
                            "$ExpectedPythonRuntime.",
                            [StringComparison]::Ordinal
                        )) {
                        $installedManifest = Join-Path `
                            (Split-Path -Parent $backendPath) 'runtime-manifest.json'
                        if (-not (Test-Path -LiteralPath $installedManifest -PathType Leaf)) {
                            throw 'Installed backend runtime manifest is missing from fresh app-data.'
                        }
                        return [pscustomobject]@{
                            pid = [int]$backendProcess.ProcessId
                            port = [int]$listener.LocalPort
                            executable = $backendPath
                            installedManifest = $installedManifest
                            health = $health
                        }
                    }
                } catch {
                    if ($_.Exception.Message -match 'fresh app-data') { throw }
                }
            }
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Bundled backend did not install into fresh app-data and return matching packaged health.'
}

function Stop-OwnedProcessTree([Diagnostics.Process]$Process) {
    if (-not $Process) { return }
    Stop-OwnedPidTree $Process.Id
}

function Stop-OwnedPidTree([int]$OwnedPid) {
    $process = Get-Process -Id $OwnedPid -ErrorAction SilentlyContinue
    if (-not $process) { return }
    $taskkill = Start-Process -FilePath 'taskkill.exe' -WindowStyle Hidden -Wait `
        -PassThru -ArgumentList @('/PID', $OwnedPid, '/T', '/F')
    if ($taskkill.ExitCode -ne 0) {
        $process.Refresh()
        if (-not $process.HasExited) {
            throw "Owned application process tree cleanup failed with exit code $($taskkill.ExitCode)."
        }
    }
}

function Assert-InstalledRuntimeContract([string]$InstallRoot, [pscustomobject]$Plan) {
    $backendManifestPath = Get-ChildItem -LiteralPath $InstallRoot -Recurse -File `
        -Filter 'backend-runtime-manifest.json' | Select-Object -First 1 -ExpandProperty FullName
    $ocrManifestPath = Get-ChildItem -LiteralPath $InstallRoot -Recurse -File `
        -Filter 'windowsml-ocr-runtime-manifest.json' | Select-Object -First 1 -ExpandProperty FullName
    if (-not $backendManifestPath -or -not $ocrManifestPath) {
        throw 'Installed runtime manifests were not found.'
    }
    $backend = Get-Content -LiteralPath $backendManifestPath -Raw | ConvertFrom-Json
    $ocr = Get-Content -LiteralPath $ocrManifestPath -Raw | ConvertFrom-Json
    if ($backend.version -ne $Plan.version -or $backend.artifact.url -ne $null) {
        throw 'Installed backend manifest does not describe the bundled alpha runtime.'
    }
    if ($ocr.version -ne $Plan.version -or
        $ocr.artifact.url -ne "$($Plan.assetBaseUrl)/$($ocr.artifact.file_name)") {
        throw 'Installed OCR manifest does not point to the public versioned release asset.'
    }
    $backendZip = Join-Path (Split-Path -Parent $backendManifestPath) $backend.artifact.file_name
    $ocrZip = Join-Path (Split-Path -Parent $ocrManifestPath) $ocr.artifact.file_name
    if (-not (Test-Path -LiteralPath $backendZip -PathType Leaf)) {
        throw 'Bundled backend runtime ZIP is missing after installation.'
    }
    if (Test-Path -LiteralPath $ocrZip) {
        throw 'WindowsML OCR runtime ZIP must not be bundled in the installed app.'
    }
    if ((Get-Item -LiteralPath $backendZip).Length -ne $backend.artifact.bytes -or
        (Get-Sha256 $backendZip) -ne $backend.artifact.sha256) {
        throw 'Bundled backend runtime ZIP failed byte/hash verification.'
    }
    foreach ($manifestPath in @($backendManifestPath, $ocrManifestPath)) {
        $content = (Get-Content -LiteralPath $manifestPath -Raw).ToLowerInvariant()
        if ($content.Contains('file://') -or $content.Contains('c:\software-dev')) {
            throw "Installed manifest contains a development reference: $manifestPath"
        }
    }
    return [pscustomobject]@{
        backendManifestPath = $backendManifestPath
        ocrManifestPath = $ocrManifestPath
        ocr = $ocr
    }
}

$candidateRoot = (Resolve-Path -LiteralPath $CandidateRoot).Path
$candidate = Get-Content -LiteralPath (Join-Path $candidateRoot 'candidate.json') -Raw |
    ConvertFrom-Json
$plan = Get-Content -LiteralPath (Join-Path $candidateRoot 'release\metadata\release-plan.json') -Raw |
    ConvertFrom-Json
if ($candidate.candidateId -ne $ExpectedCandidateId -or
    $candidate.commitSha -ne $ExpectedCommitSha -or
    $plan.commitSha -ne $ExpectedCommitSha) {
    throw 'Downloaded candidate identity does not match the workflow metadata.'
}
if (Test-Path -LiteralPath (Join-Path $env:GITHUB_WORKSPACE '.git')) {
    throw 'Clean-install verification must run without a source checkout.'
}
Assert-CandidateFiles $candidateRoot $candidate
$computedCandidateId = Get-StringSha256 (($candidate.files | Sort-Object) -join "`n")
if ($computedCandidateId -ne $candidate.candidateId) {
    throw 'Candidate ID does not match the verified file identity set.'
}

$installerPattern = if ($PackageKind -eq 'msi') { '*.msi' } else { '*setup.exe' }
$installers = @(Get-ChildItem -LiteralPath (Join-Path $candidateRoot 'release\installers') `
    -File -Filter $installerPattern)
if ($installers.Count -ne 1) {
    throw "Expected one $PackageKind installer, found $($installers.Count)."
}
$installer = $installers[0]
$beforeEntries = @(Get-CertPrepUninstallEntries)
$appProcess = $null
$backendEvidence = $null
$contract = $null
$ocrDownload = Join-Path $env:RUNNER_TEMP "$PackageKind-$($plan.version)-ocr.zip"
$freshAppData = Join-Path $env:RUNNER_TEMP `
    "cert-prep-clean-$PackageKind-$([Guid]::NewGuid().ToString('N'))"
try {
    if ($PackageKind -eq 'msi') {
        $logPath = Join-Path $env:RUNNER_TEMP 'cert-prep-msi-install.log'
        $process = Start-Process -FilePath 'msiexec.exe' -Wait -PassThru -ArgumentList @(
            '/i', $installer.FullName, '/qn', '/norestart', '/l*v', $logPath
        )
    } else {
        $process = Start-Process -FilePath $installer.FullName -Wait -PassThru -ArgumentList '/S'
    }
    if ($process.ExitCode -ne 0) {
        throw "$PackageKind installation failed with exit code $($process.ExitCode)."
    }

    $afterEntries = @(Get-CertPrepUninstallEntries)
    $newEntries = @($afterEntries | Where-Object {
        $key = $_.PSPath
        -not ($beforeEntries | Where-Object { $_.PSPath -eq $key })
    })
    $executable = Find-InstalledExecutable $(if ($newEntries.Count) { $newEntries } else { $afterEntries })
    $contract = Assert-InstalledRuntimeContract $executable.Directory.FullName $plan

    Invoke-WebRequest -Uri $contract.ocr.artifact.url -OutFile $ocrDownload -UseBasicParsing
    if ((Get-Item -LiteralPath $ocrDownload).Length -ne $contract.ocr.artifact.bytes -or
        (Get-Sha256 $ocrDownload) -ne $contract.ocr.artifact.sha256) {
        throw 'Public OCR runtime download failed byte/hash verification.'
    }

    New-Item -ItemType Directory -Path $freshAppData | Out-Null
    if (@(Get-ChildItem -LiteralPath $freshAppData -Force).Count -ne 0) {
        throw 'Clean-install app-data directory was not fresh.'
    }
    $previousDataDir = $env:CERT_PREP_DESKTOP_DATA_DIR
    $previousQaInstall = $env:CERT_PREP_PACKAGE_QA_AUTO_INSTALL_BUNDLED_BACKEND
    try {
        $env:CERT_PREP_DESKTOP_DATA_DIR = $freshAppData
        $env:CERT_PREP_PACKAGE_QA_AUTO_INSTALL_BUNDLED_BACKEND = 'true'
        $appProcess = Start-Process -FilePath $executable.FullName -PassThru
    } finally {
        $env:CERT_PREP_DESKTOP_DATA_DIR = $previousDataDir
        $env:CERT_PREP_PACKAGE_QA_AUTO_INSTALL_BUNDLED_BACKEND = $previousQaInstall
    }
    $backendEvidence = Wait-InstalledBackendHealth `
        -AppPid $appProcess.Id `
        -FreshAppData $freshAppData `
        -ExpectedVersion $plan.version `
        -ExpectedPythonRuntime $plan.pythonRuntimeVersion
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
        throw "Installed application exited during launch smoke with $($appProcess.ExitCode)."
    }

    $result = [ordered]@{
        schemaVersion = 1
        packageKind = $PackageKind
        version = $plan.version
        tag = $plan.tag
        commitSha = $plan.commitSha
        candidateId = $candidate.candidateId
        installer = $installer.Name
        installerSha256 = Get-Sha256 $installer.FullName
        backendBundled = $true
        ocrBundled = $false
        publicOcrDownloadVerified = $true
        appLaunchVerified = $true
        freshAppDataVerified = $true
        backendInstallVerified = $true
        backendHealthVerified = $true
        backendVersion = $backendEvidence.health.version
        backendRuntimeMode = $backendEvidence.health.runtime_mode
        backendPythonVersion = $backendEvidence.health.python_version
        backendExecutable = $backendEvidence.executable
        backendPort = $backendEvidence.port
    }
    $outputPath = [IO.Path]::GetFullPath($Output)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputPath) | Out-Null
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outputPath -Encoding utf8
} finally {
    Stop-OwnedProcessTree $appProcess
    if ($backendEvidence -and $backendEvidence.pid) {
        Stop-OwnedPidTree ([int]$backendEvidence.pid)
    }
    Remove-Item -LiteralPath $ocrDownload -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $freshAppData -PathType Container) {
        $resolvedFreshData = (Resolve-Path -LiteralPath $freshAppData).Path
        $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
        if (-not $resolvedFreshData.StartsWith(
            $runnerTemp + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            throw "Refusing to remove app-data outside RUNNER_TEMP: $resolvedFreshData"
        }
        Remove-Item -LiteralPath $resolvedFreshData -Recurse -Force
    }
    if ($PackageKind -eq 'msi') {
        Start-Process -FilePath 'msiexec.exe' -Wait -ArgumentList @(
            '/x', $installer.FullName, '/qn', '/norestart'
        ) -ErrorAction SilentlyContinue
    } else {
        foreach ($entry in @(Get-CertPrepUninstallEntries)) {
            if ($entry.UninstallString) {
                $rawUninstall = [string]$entry.UninstallString
                $uninstaller = if ($rawUninstall -match '^"([^"]+)"') {
                    $Matches[1]
                } else {
                    $rawUninstall.Split(' ')[0]
                }
                if (Test-Path -LiteralPath $uninstaller) {
                    Start-Process -FilePath $uninstaller -Wait -ArgumentList '/S' `
                        -ErrorAction SilentlyContinue
                }
            }
        }
    }
}
