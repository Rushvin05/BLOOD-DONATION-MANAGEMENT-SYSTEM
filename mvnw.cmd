@echo off
setlocal
set "MAVEN_VERSION=3.9.9"
set "MAVEN_HOME=%USERPROFILE%\.m2\wrapper\dists\apache-maven-%MAVEN_VERSION%\maven"
if not exist "%MAVEN_HOME%\bin\mvn.cmd" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $target=Join-Path $env:USERPROFILE '.m2\wrapper\dists\apache-maven-3.9.9'; New-Item -ItemType Directory -Force -Path $target | Out-Null; $archive=Join-Path $env:TEMP 'apache-maven-3.9.9-bin.zip'; Invoke-WebRequest -Uri 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip' -OutFile $archive; Expand-Archive -Path $archive -DestinationPath $target -Force; Move-Item -Path (Join-Path $target 'apache-maven-3.9.9') -Destination (Join-Path $target 'maven') -Force; Remove-Item $archive"
  if errorlevel 1 exit /b 1
)
call "%MAVEN_HOME%\bin\mvn.cmd" %*
exit /b %ERRORLEVEL%
