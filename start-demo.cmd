@echo off
rem Demo gateway with FAKE DATA on this computer, for building TDC Office modules.
cd /d "%~dp0"
node scripts\dev-gateway.js %*
pause
