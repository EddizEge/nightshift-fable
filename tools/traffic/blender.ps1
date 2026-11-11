# Run tools/traffic/build.py in headless Blender at Idle priority. Usage: pwsh tools/traffic/blender.ps1 <type|all>
param([string]$Which = 'all')
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$log = Join-Path $root "assets-src/traffic/build-$($Which -replace ',','_').log"
$exe = 'C:/Program Files/Blender Foundation/Blender 4.3/blender.exe'
$p = Start-Process -FilePath $exe -ArgumentList @('--background', '--factory-startup', '--python', "`"$root/tools/traffic/build.py`"", '--', $Which) -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
try { $p.PriorityClass = 'Idle' } catch {}
$p.WaitForExit()
Get-Content $log | Select-String -Pattern '\[traffic\]|Error|Traceback|line \d+' | Select-Object -First 30 | ForEach-Object { $_.Line }
Get-Content "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 15
