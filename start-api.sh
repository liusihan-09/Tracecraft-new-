#!/bin/bash
# pm2 启动 TRACECRAFT API 用，放置路径: /liyujia/Tracecraft-new-/start-api.sh

cd /liyujia/Tracecraft-new- || {
  echo "[start-api] 错误: 无法进入 /liyujia/Tracecraft-new-" >&2
  exit 1
}

if [[ ! -f .env ]]; then
  echo "[start-api] 错误: .env 不存在于 $(pwd)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

# 诊断信息写入 pm2 日志（只输出长度，不泄露密钥）
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  echo "[start-api] OPENAI 已加载: key 长度 ${#OPENAI_API_KEY}, PORT=${PORT:-4318}" >&2
else
  echo "[start-api] 提示: OPENAI_API_KEY 未设置，将使用演示模式。可在 .env 配置或登录后「模型设置」填写" >&2
fi

exec node server/index.mjs
