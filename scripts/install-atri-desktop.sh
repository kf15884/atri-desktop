#!/bin/bash
# 离线安装；先停用已有桌面实例。本脚本不重启服务、不改koishi.yml、不触碰数据库。
set -euo pipefail
ROOT=${ROOT:-/opt/hds-interlude}; SVCUSER=${SVCUSER:-hdsinterlude}
export ROOT
PKG=koishi-plugin-atri-desktop; VER=0.3.0
HERE=$(cd "$(dirname "$0")" && pwd); TGZ="$HERE/$PKG-$VER.tgz"
[ "$(id -u)" = 0 ] || { echo '请用 root 运行'; exit 1; }
for cmd in node tar sudo openssl flock; do command -v "$cmd" >/dev/null || { echo "缺少 $cmd"; exit 1; }; done
[ -f "$ROOT/package.json" ] && [ -d "$ROOT/node_modules" ] && [ -f "$TGZ" ] || { echo '工程或插件包缺失'; exit 1; }
id "$SVCUSER" >/dev/null
exec 9>"$ROOT/.atri-desktop-install.lock"; flock -n 9 || { echo '已有安装任务'; exit 1; }
ver() { ROOT="$ROOT" node -e 'try{console.log(require(process.env.ROOT+"/node_modules/"+process.argv[1]+"/package.json").version)}catch{console.log("none")}' "$1"; }
CORE=$(ver koishi-plugin-atri-core)
echo "HDS=$(ver koishi-plugin-hds-interlude) core=$CORE 旧桌面=$(ver "$PKG")"
CORE="$CORE" node -e 'const [a,b,c]=process.env.CORE.split(/[.-]/).map(Number);process.exit(a===0&&b===2&&c>=27?0:1)' || { echo '需要 core >=0.2.27 <0.3.0'; exit 1; }
# 要求旧实例先停用，不以旧包存在推断端口归属。
node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(5150,"127.0.0.1",()=>s.close())' || { echo '5150不可用：请先停用已有桌面实例或排查占用'; exit 1; }
TOKEN=$(openssl rand -hex 16)
BK="$ROOT/.atri-desktop-backups/$(date +%Y%m%dT%H%M%S%N)"
mkdir -p "$BK"; chmod 700 "$ROOT/.atri-desktop-backups" "$BK"
cp -a "$ROOT/package.json" "$BK/"
for f in package-lock.json koishi.yml; do [ ! -f "$ROOT/$f" ] || cp -a "$ROOT/$f" "$BK/"; done
[ ! -e "$ROOT/node_modules/$PKG" ] || cp -a "$ROOT/node_modules/$PKG" "$BK/old-plugin"
mkdir -p "$ROOT/vendor"
[ ! -e "$ROOT/vendor/$PKG-$VER.tgz" ] || cp -a "$ROOT/vendor/$PKG-$VER.tgz" "$BK/old-vendor.tgz"
TMP=$(mktemp -d "$ROOT/node_modules/.atri-desktop-stage.XXXXXX")
MUTATED=0
cleanup() {
  r=$?; trap - EXIT
  if [ "$r" != 0 ] && [ "$MUTATED" = 1 ]; then
    echo "安装失败，恢复安装前代码与依赖清单：$BK"
    rm -rf "$ROOT/node_modules/$PKG"
    [ ! -e "$BK/old-plugin" ] || cp -a "$BK/old-plugin" "$ROOT/node_modules/$PKG"
    cp -a "$BK/package.json" "$ROOT/package.json"
    if [ -e "$BK/old-vendor.tgz" ]; then cp -a "$BK/old-vendor.tgz" "$ROOT/vendor/$PKG-$VER.tgz"; else rm -f "$ROOT/vendor/$PKG-$VER.tgz"; fi
  fi
  rm -rf "$TMP"; exit "$r"
}
trap cleanup EXIT
tar xzf "$TGZ" -C "$TMP"
STAGE="$TMP/package" node -e 'const p=process.env.STAGE;const m=require(p+"/package.json");if(m.name!=="koishi-plugin-atri-desktop"||m.version!=="0.3.0")process.exit(1);require(p+"/node_modules/ws/package.json")'
chown -R "$SVCUSER:$(id -gn "$SVCUSER")" "$TMP/package"
MUTATED=1
cp "$TGZ" "$ROOT/vendor/$PKG-$VER.tgz"
chown "$SVCUSER:$(id -gn "$SVCUSER")" "$ROOT/vendor/$PKG-$VER.tgz"
rm -rf "$ROOT/node_modules/$PKG"; mv "$TMP/package" "$ROOT/node_modules/$PKG"
node -e 'const fs=require("fs"),f=process.env.ROOT+"/package.json",p=JSON.parse(fs.readFileSync(f));p.dependencies||={};p.dependencies["koishi-plugin-atri-desktop"]="file:vendor/koishi-plugin-atri-desktop-0.3.0.tgz";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
# sudo可能重置PATH，传入当前node的绝对位置。
sudo -u "$SVCUSER" "$(command -v node)" -e 'const p=process.argv[1];const m=require(p);if(m.name!=="atri-desktop")process.exit(1);require(p+"/node_modules/ws")' "$ROOT/node_modules/$PKG"
MUTATED=0
echo "加载自检 OK；备份 $BK"
echo '未修改数据库/配置/锁文件，未重启服务。控制台添加（或重新启用）atri-desktop，填token：'
printf '  %s\n' "$TOKEN"
echo '令牌仅在本机保存，不要发到聊天。然后按部署说明建立SSH隧道与验收。'
