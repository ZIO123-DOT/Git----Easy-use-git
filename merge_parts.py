# -*- coding: utf-8 -*-
# 合并 parts -> github-console.html，并用 node --check 校验 JS 语法
import os, re, subprocess, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
parts = ['part1.html', 'part_adapters.js.html', 'part2.js.html', 'part3.js.html', 'part4.js.html']
chunks = []
for p in parts:
    with open(os.path.join(here, 'parts', p), encoding='utf-8') as f:
        chunks.append(f.read().strip())

html = '\n'.join(chunks)
# 修复相邻重复的 <script> 标签
html = html.replace('<script>\n<script>', '<script>', 1)

# 注入猫猫 favicon（Edge app 模式的窗口/任务栏图标）
import base64
with open(os.path.join(here, 'tray.png'), 'rb') as f:
    fav = base64.b64encode(f.read()).decode()
fav_link = '<link rel="icon" type="image/png" href="data:image/png;base64,%s">' % fav
html = html.replace('</head>', fav_link + '\n</head>', 1)

# ---- 防回退闸（写入前校验，纯防御）----
# 背景：parts/ 自 2026-09-15 那批修复起就未再回写，其合并结果已落后于两份现行产物（缺 toast 定位修复、
# 拖拽上传守护等）。而本脚本会「同时覆盖」两处产物——谁执行一次，就会把后续所有修复连同新改动一起回退。
# 这种静默覆盖比构建漂移更危险，故写入前先做一次标志物体检：目标文件里存在、而 parts 合并结果里消失的
# 标志物，即判定 parts 已过期 → 拒绝写入并给出指引。确需用旧 parts 强制重建时才加 --force 逃生。
FORCE = '--force' in sys.argv[1:]
MARKERS = ['titlebar-area-height', 'treeVerify', 'gc_upload_pref', 'MAX_DROP_LIMIT']
_probe = os.path.join(here, 'electron-app', 'console.html')
if not FORCE and os.path.exists(_probe):
    with open(_probe, encoding='utf-8') as _f:
        _current = _f.read()
    _missing = [m for m in MARKERS if (m in _current) and (m not in html)]
    if _missing:
        print('拒绝写入：parts/ 合并结果缺少当前产物已存在的修复标志物 %d 个：%s' % (len(_missing), ', '.join(_missing)))
        print('说明 parts/ 已过期（自 2026-09-15 起未回写）；直接写入会回退上述标志物对应的修复。')
        print('如确需用 parts/ 强制重建两处产物，请执行：python merge_parts.py --force')
        sys.exit(1)

# 一次写入两个位置：根目录 github-console.html（Edge app 模式）与 electron-app/console.html
# （Electron 实际加载，见 desktop.cjs 的 PAGE）。此前只写根目录、靠人工复制，存在构建漂移风险。
targets = [
    os.path.join(here, 'github-console.html'),
    os.path.join(here, 'electron-app', 'console.html'),
]
for out in targets:
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print('MERGED', os.path.getsize(out), 'bytes ->', out)

# 提取所有 <script>...</script> 内容做语法检查
scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
print('script blocks:', len(scripts))
node = r'C:\Users\24697\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
ok = True
for i, s in enumerate(scripts):
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as tf:
        tf.write(s)
        tmp = tf.name
    r = subprocess.run([node, '--check', tmp], capture_output=True, text=True)
    if r.returncode != 0:
        ok = False
        print('SYNTAX ERROR in block', i, ':', r.stderr[:2000])
    else:
        print('block', i, 'OK')
    os.unlink(tmp)
print('ALL_OK' if ok else 'HAS_ERRORS')
