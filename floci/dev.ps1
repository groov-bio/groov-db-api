#!/usr/bin/env pwsh
# floci/dev.ps1 -- Windows/PowerShell one-command local dev launcher for the
# groov-db-api + groov-db-ui Floci stack. This is the Windows equivalent of
# floci/dev.sh; keep the two in sync.
#
# It builds + provisions the stack, waits until the UI has actually compiled,
# prints a ready-to-use summary (URLs, login, handy commands), then attaches
# `docker compose watch` so edits under groov-db-ui\src\ hot-reload and a
# package.json change rebuilds the image. Ctrl-C stops watching; the containers
# keep running (`docker compose down` to stop them).
#
# Requires Docker Desktop (with the WSL2 or Hyper-V backend) and PowerShell.
# Run from anywhere:  pwsh .\floci\dev.ps1   (or right-click > Run with PowerShell)

$ErrorActionPreference = 'Stop'

# Resolve a path to its REAL on-disk case (and absolute form). This matters on
# case-INSENSITIVE filesystems (Windows here, macOS for dev.sh): you can launch
# from a mis-cased directory (e.g. ...\documents\... when it is really
# ...\Documents\...), and the shell keeps that wrong case. Docker Compose
# registers the `develop.watch` paths using that working directory, but the OS
# reports file-change events under the canonical case, and Compose's
# event->trigger match is case-SENSITIVE. The mismatch makes
# `docker compose watch` PRINT "Syncing service ui after N changes were
# detected" while copying NOTHING into the container -- so UI edits appear to
# sync but never actually hot-reload. Rebuilding the path from the on-disk
# names keeps watch working.
function Get-CanonicalPath {
    param([Parameter(Mandatory)][string]$Path)
    $full = (Resolve-Path -LiteralPath $Path).Path
    try {
        $sep  = [System.IO.Path]::DirectorySeparatorChar
        $root = [System.IO.Path]::GetPathRoot($full)
        if ([string]::IsNullOrEmpty($root)) { return $full }
        # Normalize the drive letter to upper case (Docker Desktop prefers C:\).
        if ($root.Length -ge 2 -and $root[1] -eq ':') {
            $root = $root.Substring(0, 1).ToUpper() + $root.Substring(1)
        }
        $rest = $full.Substring([System.IO.Path]::GetPathRoot($full).Length).Trim($sep)
        $current = $root
        if (-not [string]::IsNullOrEmpty($rest)) {
            foreach ($segment in $rest.Split($sep)) {
                if ([string]::IsNullOrEmpty($segment)) { continue }
                $match = Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop |
                         Where-Object { $_.Name -ieq $segment } |
                         Select-Object -First 1
                if ($null -ne $match) { $current = $match.FullName }
                else { $current = Join-Path $current $segment }  # not found: keep as-is
            }
        }
        return $current
    } catch {
        return $full  # best effort: fall back to the resolved (case-as-typed) path
    }
}

# cd to the repo root (parent of this script's floci\ dir), pinned to true case.
# Compose derives each Lambda's hot-reload host path (HOST_API_DIR=${PWD}) from
# the working directory, which must be the groov-db-api repo root.
$repoRoot = Get-CanonicalPath (Join-Path $PSScriptRoot '..')
Set-Location -LiteralPath $repoRoot
Write-Host "> Working directory: $repoRoot"

$UI_URL  = 'http://localhost:3000'
$AWS_URL = 'http://localhost:4566'
$RULE    = '=================================================================='

Write-Host "> Starting groovDB local dev (build + provision from template.yaml)..."
docker compose up --build -d
if ($LASTEXITCODE -ne 0) {
    Write-Error "Stack failed to start. Inspect: docker compose logs floci-init"
    exit 1
}

# Wait (bounded) for the CRA dev server's first compile, so the banner means
# "actually ready to use", not merely "container started".
Write-Host -NoNewline "> Waiting for the UI to compile"
for ($i = 0; $i -lt 60; $i++) {
    $logs = docker compose logs ui 2>$null
    if ($logs -match '(?i)compiled successfully|webpack compiled') { break }
    Write-Host -NoNewline "."
    Start-Sleep -Seconds 2
}
Write-Host ""

# The per-run API base is written by the provisioner into the shared volume;
# read it back through the ui container (which mounts /shared read-only).
$uiEnv = docker compose exec -T ui sh -c 'cat /shared/ui.env 2>/dev/null' 2>$null
$apiBase = ($uiEnv | Select-String -Pattern '^REACT_APP_API_BASE=(.*)$' |
            Select-Object -First 1).Matches.Groups[1].Value
if ([string]::IsNullOrWhiteSpace($apiBase)) {
    $apiBase = '<not found -- see: docker compose logs floci-init>'
}

@"

$RULE
  [OK]  groovDB local dev is READY
$RULE
  UI            $UI_URL
                  sign in as  admin@groov.local  /  GroovLocal1!
  API (V2)      $apiBase
  AWS endpoint  $AWS_URL   (Floci: API GW - Lambda - Cognito - DynamoDB - S3)

  Live reload is ON:
    - edit  groov-db-ui\src\**        -> the page Fast-Refreshes
    - edit  functions\**\*.py         -> the Lambda hot-reloads on next call
    - change groov-db-ui\package.json -> the UI image rebuilds

  Handy:
    docker compose run --rm floci-init --reseed    # reset seeded data (keep the stack)
    docker compose logs -f ui                      # follow the UI dev server
    docker compose down                            # stop the stack (data kept)
    bash floci/smoke.sh                            # 17-check smoke (needs Git Bash or WSL)

  Watching for changes -- press Ctrl-C to stop watching
  (containers stay up; run 'docker compose down' to stop them).
$RULE

"@ | Write-Host

docker compose watch --no-up
