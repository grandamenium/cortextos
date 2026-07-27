@echo off
REM Thin wrapper kept for compatibility - real logic lives in start-atlasos.ps1
REM (logging, restart-safety, retries, verification).
REM Run history: logs\autostart.log
REM
REM Prefer PowerShell 7 when present; the script is written to be 5.1-safe
REM (ASCII only, no -AsHashtable) so either host works.
where /q pwsh.exe
if %ERRORLEVEL%==0 (
    pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "C:\cortext-test\cortextos\start-atlasos.ps1"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\cortext-test\cortextos\start-atlasos.ps1"
)
exit /b %ERRORLEVEL%
