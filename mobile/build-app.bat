@echo off
setlocal
title YShare mobile - build
echo ============================================================
echo   Building the YShare mobile app.
echo   First build takes ~10-20 min (it compiles a lot). Be patient.
echo   Leave this window open until it finishes.
echo ============================================================
echo.
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('JAVA_HOME','User')"`) do if not defined JAVA_HOME set "JAVA_HOME=%%I"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('ANDROID_HOME','User')"`) do if not defined ANDROID_HOME set "ANDROID_HOME=%%I"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('GRADLE_USER_HOME','User')"`) do if not defined GRADLE_USER_HOME set "GRADLE_USER_HOME=%%I"

pushd "%~dp0android"
call gradlew.bat assembleDebug > "%~dp0build-debug.log" 2>&1
set "BUILD_EXIT=%ERRORLEVEL%"
type "%~dp0build-debug.log"
popd
echo.
if not "%BUILD_EXIT%"=="0" (
  echo ============================================================
  echo   BUILD FAILED. See mobile\build-debug.log for details.
  echo ============================================================
  pause
  exit /b %BUILD_EXIT%
)
echo ============================================================
echo   BUILD SUCCESSFUL.
echo   APK: android\app\build\outputs\apk\debug\app-debug.apk
echo ============================================================
pause
exit /b 0
