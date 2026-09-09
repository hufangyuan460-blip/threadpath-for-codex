@echo off
node --experimental-strip-types "%~dp0..\..\..\..\threadpath-protocol\src\fake-app-server.ts" %*
