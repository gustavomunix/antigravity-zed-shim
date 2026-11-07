@echo off
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8123 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force; Write-Host 'Antigravity shim stopped.' }"
