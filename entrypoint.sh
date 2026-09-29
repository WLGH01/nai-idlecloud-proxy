#!/bin/sh
# 容器入口：按 PUID/PGID 调整数据目录属主后，降权运行服务。
#
# 为什么需要：镜像内以非 root（node）运行，但用户挂载的宿主目录
# （如 unraid 的 appdata）通常属 root 或 nobody:users。若不调整属主，
# 额度状态文件写不进去，表现为「重启后额度统计被重置」。
#
# 以 root 启动时：chown 数据目录 -> 用 su-exec 降权到 PUID:PGID 运行。
# 非 root 启动时（docker run --user 指定）：直接运行，不做任何提权尝试。
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
QUOTA_DIR="$(dirname "${QUOTA_FILE:-/data/quota.json}")"

if [ "$(id -u)" = "0" ]; then
    # 按需调整 node 用户的 uid/gid，使其与宿主目录属主一致
    if [ "$PGID" != "$(id -g node)" ]; then
        groupmod -o -g "$PGID" node 2>/dev/null || true
    fi
    if [ "$PUID" != "$(id -u node)" ]; then
        usermod -o -u "$PUID" node 2>/dev/null || true
    fi

    mkdir -p "$QUOTA_DIR" 2>/dev/null || true
    # 仅调整数据目录属主，避免递归改动用户挂载的其它内容
    chown -R node:node "$QUOTA_DIR" 2>/dev/null || true

    if [ -w "$QUOTA_DIR" ] || chown node:node "$QUOTA_DIR" 2>/dev/null; then
        exec su-exec node "$@"
    fi

    # 实在无法取得写权限时，明确告知而不是静默降级
    echo "[entrypoint] 警告: $QUOTA_DIR 不可写，额度状态将无法持久化。" >&2
    echo "[entrypoint] 请在宿主机执行: chown -R ${PUID}:${PGID} <宿主数据目录>" >&2
    exec su-exec node "$@"
fi

exec "$@"
