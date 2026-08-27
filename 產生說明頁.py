#!/usr/bin/env python3
"""把兩份使用說明 md 轉成 App 裡「使用說明」那一頁的內容。

⛔ md 是唯一真實來源。改說明只改 md，然後跑這支腳本，再 ./上線.sh。
   直接改 app.html 裡的 HELP_MEMBER／HELP_OFFICER＝多一份會過期的真實來源。
"""
import io, re, sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent
DOCS = HERE.parent / "4_tc8-docs"
APP  = HERE / "app.html"
SRC  = {"HELP_MEMBER": DOCS / "使用說明_夥伴版.md",
        "HELP_OFFICER": DOCS / "使用說明_幹部版.md"}

try:
    import markdown
except ImportError:
    sys.exit("需要 markdown 套件：pip3 install markdown")

def to_html(md_path):
    if not md_path.exists(): sys.exit(f"找不到 {md_path}")
    html = markdown.markdown(io.open(md_path, encoding="utf-8").read(),
                             extensions=["tables", "sane_lists"])
    # 表格要能自己橫向捲，否則整頁會跟著捲（窄螢幕實測過的坑）
    html = html.replace("<table>", '<div class="tablewrap"><table>').replace("</table>", "</table></div>")
    # 每個 ## 段落包成一張卡片，開頭的 emoji 抽成大圖示。
    # ⛔ 這一步一定要在產生器做，不能改成手刻 HTML——
    #    md 是唯一真實來源，手刻等於多一份會過期的說明書。
    html = cardify(html)
    # 這段字串會被放進 JS 的反引號樣板裡，反引號與 ${ 一定要跳脫
    return html.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")

def cardify(html):
    """把 <h2>…直到下一個 <h2> 為止 包成一張卡片；h2 開頭的 emoji 變成大圖示。"""
    parts = re.split(r"(?=<h2>)", html)
    out = []
    for seg in parts:
        if not seg.startswith("<h2>"):
            out.append(seg)          # 第一段（大標與前言）維持原樣
            continue
        # <h2>🚀　第一次進來</h2> → 圖示 + 標題
        seg = re.sub(r"<h2>([^\w\s　]{1,3})[　\s]*(.*?)</h2>",
                     r'<h2><span class="hico">\1</span>\2</h2>', seg, count=1)
        seg = seg.replace("<hr />", "")   # 卡片自己有邊界，不需要分隔線
        out.append('<section class="hcard">' + seg + '</section>')
    return "".join(out)

s = io.open(APP, encoding="utf-8").read()
start, end = s.index("/* HELP_START"), s.index("/* HELP_END */")
head = s[:start]
block = ["/* HELP_START —— ⛔ 這一段是機器產生的，不要手改。",
         "   真實來源是 4_tc8-docs/使用說明_夥伴版.md 與 使用說明_幹部版.md，",
         "   改完跑 `python3 產生說明頁.py` 再上線。手改這裡＝多一份會過期的真實來源。 */"]
for name, path in SRC.items():
    body = to_html(path)
    block.append(f"const {name} = `{body}`;")
    print(f"  {path.name} → {len(body):,} 字元")
out = head + "\n".join(block) + "\n" + s[end:]

# assert：字串比對替換靜默失敗過，一定要驗
assert "HELP_MEMBER = `<" in out and "HELP_OFFICER = `<" in out, "產生失敗，沒有寫進去"
io.open(APP, "w", encoding="utf-8").write(out)
print("✅ 已寫入 app.html（記得跑 ./上線.sh）")
