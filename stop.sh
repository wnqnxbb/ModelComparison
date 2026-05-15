#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-6663}"

if ! command -v lsof >/dev/null 2>&1; then
  echo "缺少 lsof，无法检查端口占用" >&2
  exit 1
fi

stop_port() {
  local port="$1"
  local name="$2"
  local pids

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
  if [[ -z "$pids" ]]; then
    echo "$name 未运行（端口 $port 未监听）"
    return 0
  fi

  echo "停止 $name: 端口 $port, PID ${pids//$'\n'/, }"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done <<< "$pids"

  sleep 1

  local remaining
  remaining="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
  if [[ -n "$remaining" ]]; then
    echo "$name 未在 1 秒内退出，强制停止: PID ${remaining//$'\n'/, }"
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      kill -9 "$pid" >/dev/null 2>&1 || true
    done <<< "$remaining"
  fi

  echo "$name 已停止"
}

stop_port "$WEB_PORT" "前端"
stop_port "$API_PORT" "后端"
