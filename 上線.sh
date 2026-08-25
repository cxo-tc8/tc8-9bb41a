#!/bin/bash
# 用法：./上線.sh "這次改了什麼"
# 會自動更新頁尾版本時間、commit、push
set -e
cd "$(dirname "$0")"
python3 - <<'PY'
import datetime,re
p="app.html"; s=open(p,encoding="utf-8").read()
ver=datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
s=re.sub(r'(id="verline"[^>]*>)版本 [^<]*', rf'\g<1>版本 {ver}', s)
open(p,"w",encoding="utf-8").write(s)
print("版本 →", ver)
PY
node -e "new Function(require('fs').readFileSync('app.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])" && echo "語法檢查通過"
git add -A && git commit -q -m "${1:-更新}" && git push -q origin main
echo "✅ 已上線　https://cxo-tc8.github.io/tc8-9bb41a/app.html"
echo "⚠️ GitHub Pages 快取約 10 分鐘，看不到新版就按 Cmd+Shift+R"
