@echo off
setlocal
set "ROOT=C:\Users\MC\Desktop\1"
if not exist "%ROOT%\Bootstrap.ps1" (
  echo تعذر العثور على الحزمة في C:\Users\MC\Desktop\1
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\Bootstrap.ps1" -Mode Interactive -Resume
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
