# TRACECRAFT Linux 部署说明

> 服务器：`10.64.3.250`  
> 项目目录：`/liyujia/Tracecraft-new-`  
> 仓库：https://github.com/liusihan-09/Tracecraft-new-  
> 访问：http://10.64.3.250:83

## 架构

```text
浏览器 → Nginx :83 → pm2(tracecraft-api) → Express :4318
                         ├─ dist/ 静态前端
                         ├─ /api/*
                         └─ /uploads  +  .data/（JSON）
```

| 组件 | 管理方式 |
|------|----------|
| Nginx | `systemctl`，配置见 `tracecraft.conf.example` |
| pm2 | 进程名 `tracecraft-api` |
| `.env` | 不进 Git，见 `.env.example` |
| `deploy.sh` | 一键拉代码 / build / 重启 |

## 首次部署

```bash
export PATH="/usr/local/nodejs/bin:$PATH"

# 1. 克隆
cd /liyujia
git clone https://github.com/liusihan-09/Tracecraft-new-.git

# 2. 放入部署脚本（若仓库里还没有）
#    将 deploy.sh / start-api.sh / .env.example / tracecraft.conf.example 拷到项目目录

cd /liyujia/Tracecraft-new-
cp .env.example .env
# 编辑 .env：改管理员密码；按需填 OPENAI_API_KEY
vi .env

chmod +x deploy.sh start-api.sh

# 3. Nginx
cp tracecraft.conf.example /etc/nginx/conf.d/tracecraft.conf
nginx -t && systemctl reload nginx

# 4. 部署
./deploy.sh
# GitHub 不通时：本地 scp 代码后
# SKIP_GIT=1 ./deploy.sh
```

## 日常更新

```bash
cd /liyujia/Tracecraft-new-
./deploy.sh
```

| 变体 | 命令 |
|------|------|
| 跳过 git | `SKIP_GIT=1 ./deploy.sh` |
| 强制重装依赖 | `FORCE_NPM_INSTALL=1 ./deploy.sh` |

## 常用检查

```bash
pm2 status
pm2 logs tracecraft-api
curl -s http://127.0.0.1:4318/api/auth/session
curl -I http://127.0.0.1:83/
```

演示账号（首次 seed，生产请改 `.env` 密码）：admin / admin123，user / user123
