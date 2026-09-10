@echo off
if /I "%~1"=="--version" (
  echo fake-codex 0.0.1
  exit /b 0
)
node --experimental-strip-types "%~dp0..\..\..\..\threadpath-protocol\src\fake-app-server.ts" %*
