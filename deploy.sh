#!/bin/bash
# TRACECRAFT 生产环境部署脚本
# 用法:
#   ./deploy.sh              正常部署（拉代码 + build + 重启）
#   SKIP_GIT=1 ./deploy.sh   跳过 git，仅 build + 重启（本地上传代码后用）
#
# 访问: http://10.64.3.250:83  （Nginx → Express :4318）

set -euo pipefail

# ========== 配置（按需修改）==========
APP_DIR="/liyujia/Tracecraft-new-"
PM2_NAME="tracecraft-api"
NODE_BIN="/usr/local/nodejs/bin"
GIT_BRANCH="main"
GIT_RETRY=3
KEEP_BACKUPS="${KEEP_BACKUPS:-7}"
HEALTH_URL="http://127.0.0.1:4318/api/auth/session"
WEB_URL="http://127.0.0.1:83"

export NODEJS_ORG_MIRROR="${NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"
export npm_config_disturl="${npm_config_disturl:-https://npmmirror.com/mirrors/node}"
export PATH="${NODE_BIN}:${PATH}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { echo "[ERROR] $*" >&2; exit 1; }

# 检查 node_modules 是否具备构建/运行所需的关键包
node_modules_complete() {
  [[ -d node_modules ]] || return 1
  [[ -x node_modules/.bin/vite ]] || return 1
  [[ -d node_modules/vite ]] || return 1
  [[ -d node_modules/express ]] || return 1
  [[ -x node_modules/.bin/vue-tsc ]] || return 1
  return 0
}

# 安装依赖：含 devDependencies（vite / vue-tsc）；先停 API，失败则清空后重试
run_npm_install() {
  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    log "安装依赖前暂停 API（避免占用 node_modules）..."
    pm2 stop "$PM2_NAME" || true
  fi

  local attempt
  for attempt in 1 2; do
    # .env 里 NODE_ENV=production 会跳过 devDependencies，build 需要 vite
    if env NODE_ENV=development npm install; then
      if node_modules_complete; then
        return 0
      fi
      log "npm install 后仍缺少关键包（vite / vue-tsc / express）..."
    fi
    if [[ "$attempt" -eq 1 ]]; then
      log "npm install 未成功或 node_modules 不完整，清空 node_modules 后重试..."
      rm -rf node_modules
    fi
  done
  return 1
}

cd "$APP_DIR" || die "目录不存在: $APP_DIR"

# ---------- 1. 备份本地 JSON 数据库 ----------
if [[ -f .data/db.json ]]; then
  BACKUP_DIR=".data/backups"
  mkdir -p "$BACKUP_DIR"
  cp .data/db.json "${BACKUP_DIR}/db.json.$(date +%Y%m%d_%H%M%S)"
  if [[ -f .data/secrets.json ]]; then
    cp .data/secrets.json "${BACKUP_DIR}/secrets.json.$(date +%Y%m%d_%H%M%S)"
  fi
  KEEP="${KEEP_BACKUPS:-7}"
  ls -t "${BACKUP_DIR}"/db.json.* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    log "已删除旧备份: $(basename "$old")"
  done
  ls -t "${BACKUP_DIR}"/secrets.json.* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
  done
  log "已备份 .data/db.json（保留最近 ${KEEP} 份）"
else
  log "跳过数据库备份（.data/db.json 不存在，首次部署正常）"
fi

# ---------- 2. 拉取最新代码（fetch + reset，带重试）----------
if [[ "${SKIP_GIT:-}" == "1" ]]; then
  log "跳过 git 拉取（SKIP_GIT=1）"
else
  git config pull.rebase false 2>/dev/null || true
  git config --global http.lowSpeedLimit 0 2>/dev/null || true
  git config --global http.lowSpeedTime 999999 2>/dev/null || true

  log "拉取 GitHub 最新代码 (branch: ${GIT_BRANCH})..."
  FETCH_OK=0
  for i in $(seq 1 "$GIT_RETRY"); do
    if git fetch origin "$GIT_BRANCH"; then
      git reset --hard "origin/${GIT_BRANCH}"
      log "代码已更新到 origin/${GIT_BRANCH} ($(git log -1 --oneline))"
      FETCH_OK=1
      break
    fi
    log "git fetch 失败，第 ${i}/${GIT_RETRY} 次，5 秒后重试..."
    sleep 5
  done
  [[ "$FETCH_OK" == "1" ]] || die "git fetch 失败（GitHub 443 不稳定）。可本地上传代码后执行: SKIP_GIT=1 ./deploy.sh"
fi

# ---------- 3. 加载环境变量 ----------
[[ -f .env ]] || die ".env 不存在，请先配置（可参考 .env.example）"
set -a && source .env && set +a
log "已加载 .env"

# ---------- 4. 安装依赖（仅 package.json / lock 变更或缺少 node_modules 时）----------
DEPS_HASH_FILE=".deploy-deps.sha256"
DEPS_HASH="$( (cat package.json 2>/dev/null; cat package-lock.json 2>/dev/null) | sha256sum | awk '{print $1}')"

need_npm_install() {
  [[ "${FORCE_NPM_INSTALL:-}" == "1" ]] && return 0
  [[ ! -d node_modules ]] && return 0
  [[ ! -f "$DEPS_HASH_FILE" ]] && return 0
  [[ "$(cat "$DEPS_HASH_FILE")" != "$DEPS_HASH" ]] && return 0
  node_modules_complete || return 0
  return 1
}

if need_npm_install; then
  if [[ "${FORCE_NPM_INSTALL:-}" == "1" ]]; then
    log "FORCE_NPM_INSTALL=1，重新安装依赖..."
  elif [[ ! -d node_modules ]]; then
    log "node_modules 不存在，安装依赖..."
  elif ! node_modules_complete; then
    log "node_modules 不完整（缺少 vite / vue-tsc / express），重新安装..."
  else
    log "package.json / package-lock.json 有变更，安装依赖..."
  fi
  run_npm_install || die "npm install 失败，请查看 /root/.npm/_logs/ 最新日志"
  node_modules_complete || die "依赖安装后仍不完整，请检查 npm 日志"
  echo "$DEPS_HASH" > "$DEPS_HASH_FILE"
  log "依赖安装完成，已记录版本指纹"
else
  log "依赖未变更且 node_modules 完整，跳过 npm install"
fi

# ---------- 5. 打包前端 ----------
log "打包前端..."
npm run build
[[ -f dist/index.html ]] || die "打包失败: dist/index.html 不存在"

# ---------- 6. 修复静态文件权限 ----------
chmod 755 /liyujia /liyujia/Tracecraft-new- 2>/dev/null || true
chmod -R 755 dist
mkdir -p .data/uploads .data/feedback
chmod -R 755 .data 2>/dev/null || true
log "已修复 dist/ 与 .data/ 权限"

# ---------- 7. 重启 API（重建进程以确保 .env 被 start-api.sh 重新加载）----------
log "重启 API (pm2: ${PM2_NAME})..."
[[ -x start-api.sh ]] || die "start-api.sh 不存在或不可执行（请 chmod +x start-api.sh）"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 delete "$PM2_NAME"
fi
pm2 start "$APP_DIR/start-api.sh" --name "$PM2_NAME" --interpreter bash
pm2 save
sleep 1
grep -q '\[start-api\] OPENAI' ~/.pm2/logs/tracecraft-api-error.log 2>/dev/null \
  && log "模型环境变量已加载 ✓" \
  || log "提示: 未配置 OPENAI_API_KEY 时将使用演示模式（可在页面「模型设置」配置）"

# ---------- 8. 健康检查 ----------
log "等待服务启动..."
sleep 3

curl -sf "$HEALTH_URL" >/dev/null || die "API 健康检查失败: ${HEALTH_URL}，请执行: pm2 logs ${PM2_NAME}"
log "API 健康检查通过 ✓"

HTTP_CODE=$(curl -sfI -o /dev/null -w "%{http_code}" "$WEB_URL" || echo "000")
[[ "$HTTP_CODE" == "200" ]] || die "前端检查失败: ${WEB_URL} (HTTP ${HTTP_CODE})。请确认已配置 Nginx :83（见 tracecraft.conf.example）"
log "前端访问检查通过 ✓ (HTTP ${HTTP_CODE})"

log "========================================="
log "部署完成！访问: http://10.64.3.250:83"
log "API 日志: pm2 logs ${PM2_NAME}"
log "========================================="
