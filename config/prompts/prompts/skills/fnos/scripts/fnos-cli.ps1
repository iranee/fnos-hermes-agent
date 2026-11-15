# Windows PowerShell 5.1 and PowerShell 7; no Node/npm required.
$ErrorActionPreference = 'Stop'
$CliArguments = @($args)
# -File in Windows PowerShell reinterprets empty strings and quotes. The cmd
# entry uses CLR's original argv, before PowerShell parameter conversion.
if ($CliArguments.Count -gt 0 -and $CliArguments[0] -eq '--bootstrap-cmd') {
    $RawArguments = [Environment]::GetCommandLineArgs()
    $FileIndex = [Array]::IndexOf($RawArguments, '-File')
    if ($FileIndex -lt 0 -or $RawArguments[$FileIndex + 2] -ne '--bootstrap-cmd') { exit 1 }
    $CliArguments = @($RawArguments | Select-Object -Skip ($FileIndex + 3))
}
$env:TRIM_CLI_DISTRIBUTION = 'fnos'

function Assert-RegularPath([string] $Path, [bool] $Directory) {
    $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $Item.PSIsContainer -ne $Directory) {
        throw "Unsafe cache path: $Path"
    }
}
function Ensure-Directory([string] $Path) {
    if ([IO.File]::Exists($Path) -or [IO.Directory]::Exists($Path)) { Assert-RegularPath $Path $true; return }
    $Parent = [IO.Path]::GetDirectoryName($Path)
    if ($Parent -and $Parent -ne $Path) { Ensure-Directory $Parent }
    [void][IO.Directory]::CreateDirectory($Path)
    Assert-RegularPath $Path $true
}
function Assert-Parents([string] $Path) {
    if (-not $Path) { return }
    $Parent = [IO.Path]::GetDirectoryName($Path)
    if ($Parent -and $Parent -ne $Path) { Assert-Parents $Parent }
    if (Test-Path -LiteralPath $Path) { Assert-RegularPath $Path $true }
}
function File-Hash([string] $Path) {
    $Stream = [IO.File]::OpenRead($Path)
    $Hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($Hash.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $Hash.Dispose(); $Stream.Dispose() }
}
function Assert-Bytes([string] $Path, [long] $Size, [string] $Hash) {
    Assert-RegularPath $Path $false
    if ((Get-Item -LiteralPath $Path).Length -ne $Size -or (File-Hash $Path) -ne $Hash) { throw "Runtime integrity check failed: $Path. Remove the affected cache directory and retry." }
}
function Cached-Binary {
    Assert-Parents $VersionDirectory
    if (Test-Path -LiteralPath $CacheDirectory) {
        Assert-RegularPath $CacheDirectory $true
        Assert-Bytes $Binary $Asset.binarySize $Asset.binarySha256
        return $Binary
    }
    return $null
}
function Native-Argument([string] $Value) {
    # Windows CRT quoting, including empty arguments and trailing backslashes.
    $Result = '"'
    $Slashes = 0
    foreach ($Character in $Value.ToCharArray()) {
        if ($Character -eq '\') { $Slashes++; continue }
        if ($Character -eq '"') { $Result += ('\' * ($Slashes * 2 + 1)) + '"' }
        else { $Result += ('\' * $Slashes) + $Character }
        $Slashes = 0
    }
    return $Result + ('\' * ($Slashes * 2)) + '"'
}
function Process-Info([string] $Executable, [string[]] $Arguments) {
    $Info = New-Object System.Diagnostics.ProcessStartInfo
    $Info.FileName = $Executable
    $Info.UseShellExecute = $false
    $Info.Arguments = ($Arguments | ForEach-Object { Native-Argument $_ }) -join ' '
    return $Info
}
function Registry-Setting {
    if (Test-Path Env:npm_config_registry) { return $env:npm_config_registry }
    # Read only the effective registry from an already installed npm. No install.
    $Shim = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $Shim) { return '' }
    $NpmDirectory = [IO.Path]::GetDirectoryName($Shim.Source)
    $Node = Join-Path $NpmDirectory 'node.exe'
    $Entry = Join-Path $NpmDirectory 'node_modules\npm\bin\npm-cli.js'
    if (-not [IO.File]::Exists($Entry)) { return '' }
    if (-not [IO.File]::Exists($Node)) {
        $ExistingNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $ExistingNode) { return '' }
        $Node = $ExistingNode.Source
    }
    $Process = New-Object System.Diagnostics.Process
    try {
        $Info = Process-Info $Node @($Entry, 'config', 'get', 'registry')
        $Info.RedirectStandardOutput = $true; $Info.RedirectStandardError = $true; $Info.CreateNoWindow = $true
        $Process.StartInfo = $Info
        [void]$Process.Start()
        $Output = $Process.StandardOutput.ReadToEndAsync()
        $ErrorOutput = $Process.StandardError.ReadToEndAsync()
        if (-not $Process.WaitForExit(5000)) { $Process.Kill(); $Process.WaitForExit(); return '' }
        if ($Process.ExitCode -eq 0 -and $Output.Result.Length -le 16384) { return $Output.Result.Trim() }
    } catch { return '' } finally { $Process.Dispose() }
    return ''
}
function Mirror-Url([string] $Registry) {
    if ($Registry -match '[\s\\]' -or $Registry -notmatch '^https://[^/?#]') { return $null }
    $Uri = $null
    if (-not [Uri]::TryCreate($Registry, [UriKind]::Absolute, [ref]$Uri)) { return $null }
    if ($Uri.Scheme -ne 'https' -or $Uri.UserInfo -or $Uri.Query -or $Uri.Fragment -or $Uri.DnsSafeHost -eq 'registry.npmjs.org') { return $null }
    return $Uri.GetLeftPart([UriPartial]::Authority) + $Uri.AbsolutePath.TrimEnd('/') + '/-/binary/fnos-cli/v' + $Manifest.version + '/' + $Asset.name
}
function Secure-Uri([string] $Address, [Uri] $Base) {
    try {
        $Uri = if ($Base) { New-Object Uri $Base, $Address } else { New-Object Uri $Address }
        if (-not $Uri.IsAbsoluteUri -or $Uri.Scheme -ne 'https' -or $Uri.UserInfo) { throw 'unsafe redirect' }
        return $Uri
    } catch { throw 'SOURCE: unsafe redirect' }
}
function Download-File([string] $Address, [string] $Destination) {
    Add-Type -AssemblyName System.Net.Http
    $Handler = New-Object System.Net.Http.HttpClientHandler
    $Handler.AllowAutoRedirect = $false
    # Windows PowerShell uses .NET Framework TLS defaults; explicitly allow TLS 1.2.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $Handler.UseDefaultCredentials = $false
    $Client = New-Object System.Net.Http.HttpClient -ArgumentList $Handler
    $Client.Timeout = [TimeSpan]::FromSeconds(30)
    [void]$Client.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', 'platform-cli-bootstrap')
    [void]$Client.DefaultRequestHeaders.TryAddWithoutValidation('Accept', 'application/octet-stream')
    $Cancellation = New-Object Threading.CancellationTokenSource
    $Cancellation.CancelAfter(30000)
    try {
        $Uri = Secure-Uri $Address $null
        for ($Redirects = 0; $Redirects -le 5; $Redirects++) {
            $Response = $null; $InputStream = $null; $OutputStream = $null
            try {
                try { $Response = $Client.GetAsync($Uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $Cancellation.Token).GetAwaiter().GetResult() }
                catch { throw 'SOURCE: network failure' }
                $Status = [int]$Response.StatusCode
                if ($Status -in @(301, 302, 303, 307, 308)) {
                    if ($Redirects -ge 5 -or -not $Response.Headers.Location) { throw 'SOURCE: redirect limit exceeded' }
                    $Uri = Secure-Uri $Response.Headers.Location.OriginalString $Uri
                    continue
                }
                if ($Status -ne 200) { throw "SOURCE: HTTP $Status" }
                try { $InputStream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult() } catch { throw 'SOURCE: network failure' }
                $OutputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $Buffer = New-Object byte[] 65536
                [long]$Count = 0
                while ($true) {
                    try { $Read = $InputStream.ReadAsync($Buffer, 0, $Buffer.Length, $Cancellation.Token).GetAwaiter().GetResult() } catch { throw 'SOURCE: interrupted transfer' }
                    if ($Read -eq 0) { break }
                    $Count += $Read
                    if ($Count -gt $Asset.size) { throw 'Runtime asset exceeds its fixed size' }
                    $OutputStream.Write($Buffer, 0, $Read)
                }
                if ($Count -ne $Asset.size) { throw 'Runtime asset size does not match its fixed manifest' }
                return
            } finally {
                if ($OutputStream) { $OutputStream.Dispose() }
                if ($InputStream) { $InputStream.Dispose() }
                if ($Response) { $Response.Dispose() }
            }
        }
    } finally { $Cancellation.Dispose(); $Client.Dispose(); $Handler.Dispose() }
}
function Download-Archive([string] $Destination) {
    $Sources = @(@{ Label = 'GitHub'; Url = "https://github.com/$($Manifest.githubRepository)/releases/download/v$($Manifest.version)/$($Asset.name)" })
    $Configured = Mirror-Url (Registry-Setting)
    if ($Configured) { $Sources += @{ Label = 'configured mirror'; Url = $Configured } }
    $Public = Mirror-Url 'https://registry.npmmirror.com'
    if ($Sources.Url -cnotcontains $Public) { $Sources += @{ Label = 'npmmirror'; Url = $Public } }
    foreach ($Source in $Sources) {
        try { Download-File $Source.Url $Destination; return }
        catch {
            if (-not $_.Exception.Message.StartsWith('SOURCE: ')) { throw }
            if ([IO.File]::Exists($Destination)) { [IO.File]::Delete($Destination) }
            [Console]::Error.WriteLine("Download from $($Source.Label) failed ($($_.Exception.Message.Substring(8))).")
        }
    }
    throw 'All configured download sources failed. Retry the command when a source is available.'
}
function Expand-ArchiveBounded([string] $Source, [string] $Destination) {
    $InputStream = [IO.File]::OpenRead($Source)
    $OutputStream = $null; $Gzip = $null
    try {
        $Gzip = New-Object IO.Compression.GZipStream $InputStream, ([IO.Compression.CompressionMode]::Decompress)
        $OutputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $Buffer = New-Object byte[] 65536; [long]$Count = 0
        while (($Read = $Gzip.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Count += $Read
            if ($Count -gt $Asset.binarySize) { throw 'Expanded runtime exceeds its fixed size' }
            $OutputStream.Write($Buffer, 0, $Read)
        }
    } finally {
        if ($OutputStream) { $OutputStream.Dispose() }
        if ($Gzip) { $Gzip.Dispose() }
        $InputStream.Dispose()
    }
}
function Prepare-Binary {
    $Cached = Cached-Binary
    if ($Cached) { return $Cached }
    Ensure-Directory $VersionDirectory
    if (-not ('PlatformCliDirectoryLock' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PlatformCliDirectoryLock {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateDirectoryW(string path, IntPtr security);
}
'@
    }
    $Deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not [PlatformCliDirectoryLock]::CreateDirectoryW($LockDirectory, [IntPtr]::Zero)) {
        $Code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($Code -ne 183) { throw "Cannot create runtime lock (Windows error $Code): $LockDirectory" }
        try { Assert-RegularPath $LockDirectory $true }
        catch [System.Management.Automation.ItemNotFoundException] {
            # The owner can publish ready and remove its lock after CreateDirectoryW reports contention.
        }
        $Cached = Cached-Binary
        if ($Cached) { return $Cached }
        if ([DateTime]::UtcNow -ge $Deadline) { throw "Runtime initialization is locked: $LockDirectory. Confirm initialization has ended, remove the residual lock, then retry." }
        Start-Sleep -Milliseconds 100
    }
    $Owner = "$PID-$([Guid]::NewGuid().ToString())"
    $OwnerPath = Join-Path $LockDirectory 'owner'
    try {
        [IO.File]::WriteAllText($OwnerPath, "$Owner`n", [Text.Encoding]::ASCII)
        $Cached = Cached-Binary
        if ($Cached) { return $Cached }
        [Console]::Error.WriteLine("Preparing fnos-cli $($Manifest.version) for $Platform...")
        $Archive = Join-Path $LockDirectory 'payload.gz'
        Download-Archive $Archive
        Assert-Bytes $Archive $Asset.size $Asset.sha256
        $Ready = Join-Path $LockDirectory 'ready'
        Ensure-Directory $Ready
        $ReadyBinary = Join-Path $Ready 'fnos-cli.exe'
        Expand-ArchiveBounded $Archive $ReadyBinary
        Assert-Bytes $ReadyBinary $Asset.binarySize $Asset.binarySha256
        # Directory.Move fails if destination already exists; never merges/overwrites.
        [IO.Directory]::Move($Ready, $CacheDirectory)
        return (Cached-Binary)
    } finally {
        if ([IO.File]::Exists($OwnerPath) -and [IO.File]::ReadAllText($OwnerPath).Trim() -ceq $Owner) {
            Assert-RegularPath $LockDirectory $true
            Remove-Item -LiteralPath $LockDirectory -Recurse -Force
        }
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This launcher requires Windows.' }
    $SkipValue = $false
    foreach ($Argument in $CliArguments) {
        if ($SkipValue) { $SkipValue = $false; continue }
        if ($Argument -in @('--host', '--port', '--profile', '--scheme')) { $SkipValue = $true; continue }
        if ($Argument.StartsWith('-')) { continue }
        if ($Argument -eq 'media') { [Console]::Error.WriteLine('Media commands are not available in this skill package.'); exit 2 }
        break
    }
    $Architecture = $env:PROCESSOR_ARCHITECTURE
    $Platform = switch ($Architecture.ToUpperInvariant()) { 'AMD64' { 'windows-x64' } 'ARM64' { 'windows-arm64' } default { throw 'Unsupported Windows execution architecture.' } }
    $ManifestPath = Join-Path $PSScriptRoot '..\runtime-manifest.json'
    Assert-RegularPath $ManifestPath $false
    if ((File-Hash $ManifestPath) -ne 'bb5a171b24d3a7e69ec8144c0f2733222f737168e7999a76dc3fe4683b6cc707') { throw 'The fixed runtime manifest is missing or changed. Reinstall this Skill.' }
    $Manifest = [IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
    $Asset = $Manifest.assets.$Platform
    $LocalData = $env:LOCALAPPDATA
    if (-not $LocalData) { $LocalData = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local' }
    if (-not [IO.Path]::IsPathRooted($LocalData) -or $LocalData -match '^[A-Za-z]:[^\\/]') { throw 'User cache directory must be an absolute path.' }
    $VersionDirectory = Join-Path $LocalData "Cache\fnos-cli\$($Manifest.version)"
    $CacheDirectory = Join-Path $VersionDirectory $Platform
    $LockDirectory = "$CacheDirectory.lock"
    $Binary = Join-Path $CacheDirectory 'fnos-cli.exe'
    $Target = Prepare-Binary
} catch {
    [Console]::Error.WriteLine("fnos-cli: $($_.Exception.Message)")
    exit 1
}
try {
    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = Process-Info $Target $CliArguments
    [void]$Process.Start()
    $Process.WaitForExit()
    $Code = $Process.ExitCode
    $Process.Dispose()
    exit $Code
} catch { [Console]::Error.WriteLine('Cannot execute the verified native CLI.'); exit 1 }
