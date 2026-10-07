@echo off
title Qemma - Deploy Backend to Render
color 0B

echo.
echo ═══════════════════════════════════════════
echo   Qemma Backend - Deploy to Render
echo ═══════════════════════════════════════════
echo.

cd /d E:\qemma-backend

REM ─── التحقق من Git ───
where git >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [X] Git غير مثبت.
    pause
    exit /b 1
)

REM ─── حالة Git ───
echo.
echo [1/3] Git status...
git status

REM ─── إضافة التعديلات ───
echo.
echo [2/3] Staging and committing changes...
git add .
git commit -m "Update backend: %DATE% %TIME%"

REM ─── الدفع ───
echo.
echo [3/3] Pushing to GitHub...
git push origin main
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Push فشل. قد يكون Branch مختلف أو مشكلة في المصادقة.
    pause
    exit /b 1
)

echo.
echo ═══════════════════════════════════════════
echo   ✅ تم الدفع إلى GitHub!
echo ═══════════════════════════════════════════
echo.
echo   Render سيسحب التعديلات تلقائياً.
echo   افتح: https://dashboard.render.com
echo.
pause