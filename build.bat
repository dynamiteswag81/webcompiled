@echo off
rem ======================================================================
rem  WiiCompiled for the Web - one-click build and start.
rem
rem  Double-click this file. It needs nothing installed (Windows 10/11 with
rem  its built-in Windows PowerShell 5.1) and no administrator rights.
rem  Put your own game file in the web\game folder first.
rem
rem  First run: downloads a pinned toolchain into the tools folder, builds
rem  the game for the browser (about 30 minutes), then serves it and opens
rem  your browser. Later runs start in seconds.
rem
rem  Options (all optional, passed to web\windows\build-windows.ps1):
rem    --rebuild   build again   --jobs N   use less memory/CPU
rem    --port N    other port    --lan      let other devices connect
rem    --no-serve  build only    --no-browser
rem
rem  Set MKW_NO_PAUSE=1 to skip the final "press any key" (for scripts).
rem
rem  This file must keep Windows (CRLF) line endings; see .gitattributes.
rem ======================================================================
setlocal EnableExtensions DisableDelayedExpansion
title WiiCompiled for the Web

rem Folder of this file, with a trailing backslash. Quoted so spaces and & are safe.
set "MKW_ROOT=%~dp0"
set "MKW_ERR=1"

rem Work from the repository folder (pushd also copes with a network/UNC location).
pushd "%MKW_ROOT%" >nul 2>nul

if not exist "%MKW_ROOT%web\windows\build-windows.ps1" goto :missing

rem Windows PowerShell 5.1 from its fixed location (not whatever "powershell" is on PATH).
set "MKW_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%MKW_PS%" set "MKW_PS=powershell"

"%MKW_PS%" -NoProfile -ExecutionPolicy Bypass -File "%MKW_ROOT%web\windows\build-windows.ps1" %*
set "MKW_ERR=%ERRORLEVEL%"
goto :finish

:missing
setlocal EnableDelayedExpansion
echo.
echo   Part of the WiiCompiled download is missing:
echo       !MKW_ROOT!web\windows\build-windows.ps1
echo.
echo   If you downloaded a ZIP file: right-click it, choose "Extract All...",
echo   and double-click build.bat in the extracted folder (not inside the ZIP).
endlocal
set "MKW_ERR=1"

:finish
echo.
if "%MKW_ERR%"=="0" (
  echo   Finished.
) else if "%MKW_ERR%"=="2" (
  echo   Nothing was built yet: follow the steps above, then double-click build.bat again.
) else (
  echo   Stopped with an error. The messages above and the file web\build\build.log
  echo   say what happened. If Windows says "running scripts is disabled", your
  echo   PC's policy blocks PowerShell scripts; ask whoever manages this PC.
)
echo.
if not defined MKW_NO_PAUSE (
  echo   Press any key to close this window.
  pause >nul
)
popd >nul 2>nul
endlocal & exit /b %MKW_ERR%
