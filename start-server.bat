@echo off
rem ======================================================================
rem  WiiCompiled for the Web - start the game server.
rem
rem  Double-click to serve the game built by build.bat (web\dist) and open
rem  it in your browser. The server runs in this window: CLOSE THIS WINDOW
rem  (or press Ctrl+C) TO STOP IT.
rem
rem  Options:  --port N    use another port (default 8080)
rem            --lan       let other devices on your network connect (HTTPS with a
rem                        self-signed certificate: browsers show a warning once)
rem
rem  This file must keep Windows (CRLF) line endings; see .gitattributes.
rem ======================================================================
setlocal EnableExtensions DisableDelayedExpansion
title WiiCompiled server - close this window to stop
set "MKW_ROOT=%~dp0"
pushd "%MKW_ROOT%" >nul 2>nul

set "MKW_PORT=8080"
set "MKW_LAN="
set "MKW_SCHEME=http"
:args
if "%~1"=="" goto :argsdone
if /i "%~1"=="--port" (set "MKW_PORT=%~2" & shift & shift & goto :args)
if /i "%~1"=="--lan" (set "MKW_LAN=--lan --https" & set "MKW_SCHEME=https" & shift & goto :args)
shift
goto :args
:argsdone

if not exist "%MKW_ROOT%web\dist\index.html" (
  echo.
  echo   The game has not been built yet.
  echo   Put your game file in web\game, double-click build.bat, then run this again.
  echo.
  pause
  popd >nul 2>nul
  exit /b 1
)

rem Prefer the portable Python build.bat installed; fall back to one on PATH.
set "MKW_PY=%MKW_ROOT%tools\python\python.exe"
if not exist "%MKW_PY%" set "MKW_PY=python"

echo.
echo   WiiCompiled server
echo   ------------------
echo   Open:  %MKW_SCHEME%://localhost:%MKW_PORT%/   (Chrome or Edge)
if defined MKW_LAN echo   Other devices: %MKW_SCHEME%://THIS-PC-IP:%MKW_PORT%/  (accept the certificate warning)
echo.
echo   Keep this window open while you play.
echo   CLOSE THIS WINDOW (or press Ctrl+C) TO STOP THE SERVER.
echo.

start "" "%MKW_SCHEME%://localhost:%MKW_PORT%/"
"%MKW_PY%" "%MKW_ROOT%web\serve.py" --dir "%MKW_ROOT%web\dist" %MKW_LAN% --port %MKW_PORT% -q

echo.
echo   The server stopped.
pause
popd >nul 2>nul
endlocal
