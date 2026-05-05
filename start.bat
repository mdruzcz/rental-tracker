@echo off
echo ========================================
echo  STR Tracker - Deploy to Vercel
echo ========================================
echo.

echo [1/3] Adding all changes to git...
git add -A
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: git add failed
    pause
    exit /b 1
)

echo [2/3] Committing changes...
set /p MSG="Commit message (or press Enter for default): "
if "%MSG%"=="" set MSG=Update STR Tracker
git commit -m "%MSG%"
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Nothing to commit or commit failed
)

echo [3/3] Pushing to remote and triggering Vercel deploy...
git push
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: git push failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo  Deploy triggered! Check Vercel dashboard
echo  for deployment status.
echo ========================================
echo.
pause
