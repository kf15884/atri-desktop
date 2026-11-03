#!/bin/bash
# 回退：先在 Koishi 控制台停用并删除 atri-desktop 实例，再运行本脚本。不动数据库与 data/atri-desktop。
set -euo pipefail
ROOT=${ROOT:-/opt/hds-interlude}; PKG=koishi-plugin-atri-desktop
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
grep -q 'atri-desktop' "$ROOT/koishi.yml" 2>/dev/null && { echo "koishi.yml 仍有 atri-desktop 实例，请先在控制台删除"; exit 1; }
rm -rf "$ROOT/node_modules/$PKG"
node -e "const f='$ROOT/package.json',p=require(f);if(p.dependencies)delete p.dependencies['$PKG'];require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
echo "已移除 $PKG（vendor 包与 data/atri-desktop/history.jsonl 保留，可手动删除）"
