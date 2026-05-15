#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-0.0.0.0}"
API_PORT="${API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-6663}"

LOG_DIR="$ROOT_DIR/logs"
API_LOG_FILE="$LOG_DIR/api.log"
WEB_LOG_FILE="$LOG_DIR/web.log"

mkdir -p "$LOG_DIR"

if ! command -v lsof >/dev/null 2>&1; then
  echo "缺少 lsof，无法检查端口占用" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "缺少 npm，请先安装 Node.js / npm" >&2
  exit 1
fi

detect_lan_ip() {
  local default_if
  default_if="$(route -n get default 2>/dev/null | awk '/interface: / {print $2; exit}')"
  if [[ -n "$default_if" ]]; then
    ipconfig getifaddr "$default_if" 2>/dev/null && return 0
  fi

  if command -v ifconfig >/dev/null 2>&1; then
    ifconfig | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}'
  fi
}

LAN_IP="$(detect_lan_ip || true)"
DISPLAY_HOST="${LAN_IP:-127.0.0.1}"

api_pid="$(lsof -tiTCP:"$API_PORT" -sTCP:LISTEN || true)"
if [[ -n "$api_pid" ]]; then
  echo "后端端口 $API_PORT 已被占用"
  echo "PID: $api_pid"
  echo "后端地址: http://127.0.0.1:$API_PORT"
  [[ -n "$LAN_IP" ]] && echo "后端局域网地址: http://$LAN_IP:$API_PORT"
  exit 0
fi

web_pid="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN || true)"
if [[ -n "$web_pid" ]]; then
  echo "前端端口 $WEB_PORT 已被占用"
  echo "PID: $web_pid"
  echo "前端地址: http://127.0.0.1:$WEB_PORT"
  [[ -n "$LAN_IP" ]] && echo "前端局域网地址: http://$LAN_IP:$WEB_PORT"
  exit 0
fi

echo "后台启动后端..."
nohup env PORT="$API_PORT" npm run server >"$API_LOG_FILE" 2>&1 &
api_bg_pid="$!"

sleep 1

if ! kill -0 "$api_bg_pid" >/dev/null 2>&1; then
  echo "后端启动失败，请检查日志: $API_LOG_FILE" >&2
  exit 1
fi

echo "后台启动前端..."
nohup npx vite --host "$HOST" --port "$WEB_PORT" >"$WEB_LOG_FILE" 2>&1 &
web_bg_pid="$!"

sleep 2

if ! kill -0 "$web_bg_pid" >/dev/null 2>&1; then
  echo "前端启动失败，请检查日志: $WEB_LOG_FILE" >&2
  exit 1
fi

api_listening_pid="$(lsof -tiTCP:"$API_PORT" -sTCP:LISTEN || true)"
web_listening_pid="$(lsof -tiTCP:"$WEB_PORT" -sTCP:LISTEN || true)"

if [[ -z "$api_listening_pid" ]]; then
  echo "后端进程已启动，但端口 $API_PORT 尚未监听，请检查日志: $API_LOG_FILE" >&2
  exit 1
fi

if [[ -z "$web_listening_pid" ]]; then
  echo "前端进程已启动，但端口 $WEB_PORT 尚未监听，请检查日志: $WEB_LOG_FILE" >&2
  exit 1
fi

echo "启动成功"
echo "前端本机地址: http://127.0.0.1:$WEB_PORT (PID: $web_listening_pid)"
echo "后端本机地址: http://127.0.0.1:$API_PORT (PID: $api_listening_pid)"
if [[ -n "$LAN_IP" ]]; then
  echo "前端局域网地址: http://$DISPLAY_HOST:$WEB_PORT"
  echo "后端局域网地址: http://$DISPLAY_HOST:$API_PORT"
else
  echo "未能自动识别局域网 IP，请手动查看本机 IP 后访问端口"
fi
echo "前端日志: $WEB_LOG_FILE"
echo "后端日志: $API_LOG_FILE"
