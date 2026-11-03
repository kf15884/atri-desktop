#!/bin/bash
# 仅隔离测试目录；不要在生产工程运行。参考包路径参数应指向含 packages/ 的目录。
set -euo pipefail
BASE=$(cd "$(dirname "$0")/.." && pwd)
R=${1:?用法：bash test/setup-env.sh /path/to/Atri15884-main-reference}
R=$(cd "$R" && pwd)
mkdir -p "$BASE/env"
cd "$BASE/env"
[ -f package.json ] || npm init -y >/dev/null
npm install --legacy-peer-deps koishi@4.18.11 @koishijs/plugin-http@0.6.3 @koishijs/plugin-database-sqlite@4.7.0 ws@8.22.0 qface@1.4.1 undici@7.30.0
N="$BASE/env/node_modules"
for PKG in koishi-plugin-hds-interlude koishi-plugin-atri-core; do
  [ -f "$R/packages/$PKG/package.json" ]
  rm -rf "$N/$PKG"; cp -r "$R/packages/$PKG" "$N/"
done
mkdir -p "$BASE/plugin/node_modules"
[ -d "$BASE/plugin/node_modules/ws" ] || cp -r "$N/ws" "$BASE/plugin/node_modules/"
rm -rf "$N/koishi-plugin-atri-desktop"; cp -r "$BASE/plugin" "$N/koishi-plugin-atri-desktop"
echo '测试环境准备完成：node test/unit.cjs && node test/e2e.cjs && node test/bridge.cjs'
