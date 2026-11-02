@echo off
REM Optional developer environment for Win Island.
REM
REM A normal Node.js + Rust + MSVC installation needs none of this. The file
REM exists for portable toolchains kept outside the system PATH: if
REM %USERPROFILE%\AI\tools contains Rust / Node / Git, they are put on PATH and
REM Cargo builds into that folder instead of the project. When the folder is
REM absent every block is skipped and the system PATH is used as is.

set "WI_TOOLS=%USERPROFILE%\AI\tools"

REM Note: the PATH line repeats the cargo folder literally — a variable set in
REM the same parenthesised block is not visible to %EXPANSION% inside it.
if exist "%WI_TOOLS%\rust\cargo\bin\cargo.exe" (
  set "RUSTUP_HOME=%WI_TOOLS%\rust\rustup"
  set "CARGO_HOME=%WI_TOOLS%\rust\cargo"
  set "CARGO_TARGET_DIR=%WI_TOOLS%\rust\target"
  set "PATH=%WI_TOOLS%\rust\cargo\bin;%PATH%"
)
if exist "%WI_TOOLS%\node\node.exe" set "PATH=%WI_TOOLS%\node;%PATH%"
if exist "%WI_TOOLS%\git\cmd\git.exe" set "PATH=%WI_TOOLS%\git\cmd;%PATH%"

REM Remote debugging for scripts\cdp.mjs (dev only, localhost).
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222"

if defined VSCMD_VER goto :vs_done
for %%R in ("%ProgramFiles(x86)%\Microsoft Visual Studio" "%ProgramFiles%\Microsoft Visual Studio") do (
  for /d %%Y in ("%%~R\*") do (
    for %%E in (BuildTools Community Professional Enterprise) do (
      if not defined VSCMD_VER if exist "%%~Y\%%E\VC\Auxiliary\Build\vcvars64.bat" call "%%~Y\%%E\VC\Auxiliary\Build\vcvars64.bat" >nul 2>nul
    )
  )
)
:vs_done
