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

# ── 上線前把關（每一條都對應 2026-08-26 真的出過的事）──
python3 - <<'CHECK'
import io, re, sys
s = io.open("app.html", encoding="utf-8").read()
bad = []

# ① 中文識別字：`const 現任` 少一個空格就變成 `const現任`，語法檢查抓不到，
#    中文字元讓錯誤在視覺上完全看不出來 → 夥伴管理整頁空白（2026-08-26）
for m in re.finditer(r'\b(const|let|var|function)\s*([^\x00-\x7F][^\s=(]*)', s):
    line = s[:m.start()].count("\n") + 1
    bad.append(f"第 {line} 行：識別字用了中文「{m.group(2)[:12]}」——一律用英文")

# ② 未授權欄位當查詢條件：整個查詢會被拒 401，不是只有那一欄讀不到
#    （2026-08-26 加了 status=is.null → 全站名冊掛掉三分鐘）
UNGRANTED = ["status", "line_user_id", "bound_at", "exit_date", "joined_at", "admin_link"]
for m in re.finditer(r'rest\(\s*["`]([^"`]+)["`]', s):
    q = m.group(1)
    if not q.startswith("members"):
        continue
    for col in UNGRANTED:
        if re.search(rf'[?&]{col}=', q) or re.search(rf'select=[^&]*\b{col}\b', q):
            line = s[:m.start()].count("\n") + 1
            bad.append(f"第 {line} 行：members 查詢用了未授權欄位「{col}」——整個查詢會被拒 401，改走 Edge Function")

# ③ members 不能用 select=*（有刻意不授權的欄位，用 * 會整個被拒）
for m in re.finditer(r'members\?[^"`]*select=\*', s):
    line = s[:m.start()].count("\n") + 1
    bad.append(f"第 {line} 行：members 用了 select=* ——會整個查詢被拒")

if bad:
    print("\n🔴 上線前檢查沒過：")
    for b in bad: print("   " + b)
    sys.exit(1)
print("上線前檢查通過（中文識別字／未授權欄位／select=*）")
CHECK
git add -A && git commit -q -m "${1:-更新}" && git push -q origin main
echo "✅ 已上線　https://cxo-tc8.github.io/tc8-9bb41a/app.html"
echo "⚠️ GitHub Pages 快取約 10 分鐘，看不到新版就按 Cmd+Shift+R"
