@echo off
setlocal
title YShare mobile - PRODUCTION release build
echo ============================================================
echo   Building the production YShare release app.
echo   This requires the final app identity, external private signing
echo   values, and the production TLS signaling/relay configuration.
echo   It is NOT the development or cellular-test build path.
echo   First release build can take ~10-20 min. Be patient.
echo   Leave this window open until it finishes.
echo ============================================================
echo.
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('JAVA_HOME','User')"`) do if not defined JAVA_HOME set "JAVA_HOME=%%I"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('ANDROID_HOME','User')"`) do if not defined ANDROID_HOME set "ANDROID_HOME=%%I"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('GRADLE_USER_HOME','User')"`) do if not defined GRADLE_USER_HOME set "GRADLE_USER_HOME=%%I"

pushd "%~dp0android"
call gradlew.bat assembleRelease > "%~dp0build-release.log" 2>&1
set "BUILD_EXIT=%ERRORLEVEL%"
type "%~dp0build-release.log"
popd
echo.
if not "%BUILD_EXIT%"=="0" (
  echo ============================================================
  echo   RELEASE BUILD FAILED. See mobile\build-release.log.
  echo ============================================================
  pause
  exit /b %BUILD_EXIT%
)
echo ============================================================
echo   RELEASE BUILD SUCCESSFUL.
echo   APK: android\app\build\outputs\apk\release\app-release.apk
echo ============================================================
pause
exit /b 0
