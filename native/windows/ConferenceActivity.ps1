$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)
[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)

try {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ConferenceActivity.cs') -Raw -Encoding UTF8
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  [Watson.WindowsActivity.CoreAudioActivity]::Initialize()
  [Console]::Out.WriteLine('{"type":"ready","protocol":1}')
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ($line.Length -gt 16384) { throw 'Core Audio metadata request exceeded its bound' }
    $request = ConvertFrom-Json -InputObject $line
    if ($request.type -eq 'stop') { break }
    if ($request.type -ne 'sample' -or $request.requestId -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid Core Audio metadata request' }
    $allowed = [string[]]@($request.allowedExecutables)
    $browsers = [string[]]@($request.browserExecutables)
    $excludedNames = [string[]]@($request.excludedExecutables)
    $excludedPids = [uint32[]]@($request.excludedPids)
    if ($allowed.Length -gt 128 -or $browsers.Length -gt 128 -or $excludedNames.Length -gt 128 -or $excludedPids.Length -gt 256) { throw 'Core Audio metadata scope exceeded its bound' }
    foreach ($name in @($allowed) + @($browsers) + @($excludedNames)) {
      if ($name -notmatch '^[a-z0-9][a-z0-9 ._-]{0,239}\.exe$') { throw 'Invalid Core Audio executable scope' }
    }
    $snapshot = [Watson.WindowsActivity.CoreAudioActivity]::Read([string]$request.requestId, $allowed, $browsers, $excludedPids, $excludedNames)
    [Console]::Out.WriteLine(($snapshot | ConvertTo-Json -Depth 8 -Compress))
  }
} catch {
  $message = 'Windows Core Audio metadata is unavailable: ' + $_.Exception.Message
  if ($message.Length -gt 2000) { $message = $message.Substring(0, 2000) }
  [Console]::Out.WriteLine((@{ type = 'error'; protocol = 1; message = $message } | ConvertTo-Json -Compress))
  exit 1
} finally {
  if ('Watson.WindowsActivity.CoreAudioActivity' -as [type]) { [Watson.WindowsActivity.CoreAudioActivity]::Shutdown() }
}
