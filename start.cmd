@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  for /d %%D in ("%LOCALAPPDATA%\ESCE-dev-tools\node-v*-win-x64") do (
    if exist "%%D\node.exe" set "PATH=%%D;%PATH%"
  )
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Zainstaluj Node.js 24 lub nowszy, a potem uruchom ten plik ponownie.
  goto failed
)

node -e "if(Number(process.versions.node.split('.')[0])<24){console.error('Wymagany Node.js 24 lub nowszy.');process.exit(1)}"
if errorlevel 1 goto failed

if not exist "node_modules\vite\bin\vite.js" (
  call npm.cmd ci
  if errorlevel 1 goto failed
)

call npm.cmd run setup
if errorlevel 1 goto failed
echo.
echo Strona: http://127.0.0.1:5173
echo Panel CMS: http://127.0.0.1:5173/adminpanel
echo Haslo do panelu znajdziesz w pliku .env.
echo Zatrzymaj serwer przez Ctrl+C.
echo.
call npm.cmd run dev
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Nie udalo sie uruchomic strony. Sprawdz komunikat powyzej.
pause
exit /b 1
