# scripts/gen-voice-fixtures.ps1 - [V2] owner V2-W1-07-media-voice. USER-RUN ONLY (T2 7.1 / 7.4, M-VOICE-1); never run by an agent,
# never part of `npm test` or `verify`.
#
# Speaks the SYNTHETIC sentences of tests/golden/voice.jsonl (rule T5: no real names, numbers or messages) with Windows SAPI
# text-to-speech and writes one 16 kHz mono PCM16 WAV per case into the git-ignored private folder (rule T12: no media in the repo):
#     $env:WCA_GOLDEN_PRIVATE_DIR   (default: %LOCALAPPDATA%\wca-golden-private\)  ->  <dir>\voice\<case id>.wav
# The live golden runner (`npm run test:golden:live -- --feature voice`) feeds these WAVs straight into voice/whisperCli.ts.
# Hebrew needs an installed Hebrew SAPI voice (T2 concern 10): without one the Hebrew and mixed cases are SKIPPED with a warning and
# the M-VOICE-1 user-recorded note decides the tier instead. Nothing is downloaded, nothing is sent anywhere.
[CmdletBinding()]
param(
  [string]$OutDir = $(if ($env:WCA_GOLDEN_PRIVATE_DIR) { $env:WCA_GOLDEN_PRIVATE_DIR } else { Join-Path $env:LOCALAPPDATA 'wca-golden-private' }),
  [string]$Cases = (Join-Path (Split-Path -Parent $PSScriptRoot) 'tests\golden\voice.jsonl')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$target = [System.IO.Path]::GetFullPath((Join-Path $OutDir 'voice'))
# T12: the private folder must never be inside the repository
if ($target.StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "WCA_GOLDEN_PRIVATE_DIR must be outside the repository ($repo)"
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo }
$hebrew = $voices | Where-Object { $_.Culture.Name -like 'he*' } | Select-Object -First 1
$english = $voices | Where-Object { $_.Culture.Name -like 'en*' } | Select-Object -First 1
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

$written = 0
$skipped = 0
foreach ($line in Get-Content -LiteralPath $Cases -Encoding UTF8) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $case = $line | ConvertFrom-Json
  if ($case.id -notmatch '^voice-(he|en|mixed)-\d{2}$') { throw "unexpected case id" }
  $text = $case.messages[0].text
  $voice = if ($case.lang -eq 'en') { $english } else { $hebrew }
  if ($null -eq $voice) {
    Write-Warning "no $($case.lang) SAPI voice installed - skipping $($case.id) (M-VOICE-1 decides the tier)"
    $skipped++
    continue
  }
  $synth.SelectVoice($voice.Name)
  $file = Join-Path $target ("{0}.wav" -f $case.id)
  $synth.SetOutputToWaveFile($file, $format)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  $written++
}
$synth.Dispose()
Write-Host "gen-voice-fixtures: wrote $written WAV file(s) to $target; skipped $skipped (missing voice)."
