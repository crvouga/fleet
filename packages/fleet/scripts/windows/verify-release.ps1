param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Publisher,
    [Parameter(Mandatory)][string]$Revision,
    [Parameter(Mandatory)][long]$RunId,
    [Parameter(Mandatory)][string]$Proof
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-FleetSignature($Signature, [string]$ExpectedPublisher) {
    if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) { throw 'FLEET-SIGNING-CONFIG: expected publisher is required.' }
    if ($Signature.Status.ToString() -cne 'Valid') { throw 'FLEET-SIGNATURE-INVALID: Windows did not validate the Authenticode signature.' }
    if ($null -eq $Signature.SignerCertificate -or $Signature.SignerCertificate.Subject -cne $ExpectedPublisher) {
        throw 'FLEET-SIGNATURE-PUBLISHER: signature does not match the configured verified publisher.'
    }
    if ($null -eq $Signature.TimeStamperCertificate) { throw 'FLEET-SIGNATURE-TIMESTAMP: a trusted timestamp is required.' }
    $usage = @($Signature.SignerCertificate.Extensions |
        Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
        ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
    if ('1.3.6.1.5.5.7.3.3' -notin $usage) { throw 'FLEET-SIGNATURE-USAGE: certificate does not permit code signing.' }
}

if ($Revision -cnotmatch '^[0-9a-f]{40}$') { throw 'FLEET-SIGNING-REVISION: expected an exact Git commit.' }
if ($RunId -le 0) { throw 'FLEET-SIGNING-RUN: expected a source CI run ID.' }
$executable = (Resolve-Path -LiteralPath $Path).Path
if ([IO.Path]::GetFileName($executable) -cne 'fleet-installer-windows-x64.exe') { throw 'FLEET-SIGNING-FILE: unexpected installer filename.' }
$signature = Get-AuthenticodeSignature -LiteralPath $executable
Assert-FleetSignature $signature $Publisher
# SignTool additionally verifies every embedded signature and the timestamp chain.
$tools = @(Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" | Sort-Object FullName -Descending)
if ($tools.Count -eq 0) { throw 'FLEET-SIGNING-TOOLS: Windows SDK SignTool is missing.' }
& $tools[0].FullName verify /pa /all /tw $executable
if ($LASTEXITCODE -ne 0) { throw 'FLEET-SIGNATURE-TRUST: SignTool verification failed.' }
$proofData = [ordered]@{
    runId = $RunId
    revision = $Revision
    file = [IO.Path]::GetFileName($executable)
    sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    publisher = $signature.SignerCertificate.Subject
    certificateThumbprint = $signature.SignerCertificate.Thumbprint
    timestampCertificateThumbprint = $signature.TimeStamperCertificate.Thumbprint
}
$proofData | ConvertTo-Json | Set-Content -LiteralPath $Proof -Encoding utf8NoBOM
Write-Output 'FLEET-SIGNATURE-VERIFIED: publisher, Windows trust, timestamp and final download hash verified.'
