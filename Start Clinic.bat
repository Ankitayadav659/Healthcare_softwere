@echo off
title Pallavi Physio Clinic Server
py -3 "%~dp0app_server.py"
if errorlevel 1 (
  echo.
  echo Clinic server stopped or could not start. Check the message above.
  pause
)
