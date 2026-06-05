@echo off
cd /d C:\cortext-test\cortextos
pm2 start ecosystem.config.js 2>nul
pm2 save 2>nul
