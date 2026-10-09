#!/usr/bin/env python3
"""视觉规范预览页生成器（纯标准库）

用途：把 apps/mp/styles/ 下的设计系统（主题色板 / 糖果图标 / 动效 / 装饰 / 共享组件）
     编译成一份可在浏览器打开的 HTML 预览页，方便在不开微信开发者工具的情况下
     核对视觉规范。产物写到 logs/（已 gitignore），不进仓库。

原理：styles/*.scss 里只用了「变量 + 平铺规则」，没有嵌套与 mixin，
     因此可以用变量替换的方式完成 SCSS→CSS 编译；rpx 按 750 设计稿折半转 px。

用法：
    python scripts/dev/gen-visual-preview.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STYLE_DIR = ROOT / 'apps' / 'mp' / 'styles'
OUT = ROOT / 'logs' / 'mp-visual-preview.html'

# 参与编译的样式文件（顺序即层叠顺序）
FILES = ['themes.scss', 'motion.scss', 'icons.scss', 'deco.scss', 'components.scss']


def load_tokens() -> dict[str, str]:
    """tokens.scss 里的 $name: value; 映射"""
    text = (STYLE_DIR / 'tokens.scss').read_text(encoding='utf-8')
    return dict(re.findall(r'^\$([\w-]+):\s*([^;]+);', text, re.M))


def compile_scss(text: str, tokens: dict[str, str]) -> str:
    """把 SCSS 变量替换掉，再把 rpx 折半成 px"""
    # ① 先处理 #{$var} 插值
    text = re.sub(r'#\{\$([\w-]+)\}', lambda m: tokens.get(m.group(1), '').strip(), text)
    # ② 再处理裸变量（循环若干次以支持变量引用变量）
    for _ in range(4):
        text = re.sub(
            r'\$([\w-]+)',
            lambda m: tokens.get(m.group(1), '0').strip(),
            text,
        )
    # ③ rpx → px（750 设计稿，按 375 视口折半）
    def rpx(m: re.Match[str]) -> str:
        return f'{float(m.group(1)) / 2:g}px'

    text = re.sub(r'([\d.]+)rpx', rpx, text)
    # ④ page 选择器在浏览器里不存在，映射到预览容器
    text = re.sub(r'(^|\n)page\s*\{', r'\1.qz-page {', text)
    return text


def build_css() -> str:
    tokens = load_tokens()

    def to_px(value: str) -> str:
        return re.sub(r'([\d.]+)rpx', lambda m: f'{float(m.group(1)) / 2:g}px', value).strip()

    parts = [
        '/* ==== tokens.scss（已展开为字面量） ==== */',
        ':root {\n' + '\n'.join(f'  --t-{k}: {to_px(v)};' for k, v in tokens.items()) + '\n}',
    ]
    for name in FILES:
        raw = (STYLE_DIR / name).read_text(encoding='utf-8')
        parts.append(f'/* ==== {name} ==== */\n' + compile_scss(raw, tokens))
    return '\n\n'.join(parts)


def read_themes() -> list[tuple[str, dict[str, str]]]:
    """解析 themes.scss，得到 [(类名, {变量: 值})]"""
    text = (STYLE_DIR / 'themes.scss').read_text(encoding='utf-8')
    out: list[tuple[str, dict[str, str]]] = []
    for m in re.finditer(r'\.(th-[\w-]+)\s*\{([^}]*)\}', text):
        props = dict(re.findall(r'--([\w-]+):\s*([^;]+);', m.group(2)))
        out.append((m.group(1), props))
    return out


def read_icons() -> list[str]:
    text = (STYLE_DIR / 'icons.scss').read_text(encoding='utf-8')
    return sorted(set(re.findall(r'\.qz-i-([\w-]+)\s*\{', text)))


THEME_LABEL = {
    'th-home': '首页', 'th-toolbox': '工具箱', 'th-os': '青智 OS', 'th-station': '青智驿站',
    'th-mine': '我的', 'th-login': '登录', 'th-tool-run': '工具执行', 'th-tool-result': '生成结果',
    'th-files': '我的文件', 'th-plan': '任务看板', 'th-task': '任务详情', 'th-order': '订单',
    'th-publish': '发布需求', 'th-workbench': '服务者工作台', 'th-provider': '服务者主页',
    'th-apply': '服务者认证', 'th-skill': '技能画像', 'th-chat': '会话', 'th-wallet': '钱包',
    'th-credit': '信用', 'th-verify': '学生认证', 'th-settings': '设置',
}


def theme_card(cls: str, props: dict[str, str]) -> str:
    swatches = ''.join(
        f'<span class="sw" style="background:{props.get(k, "#ccc")}" title="{k}"></span>'
        for k in ('m1', 'm2', 'm3', 'm4', 'ms', 'mt')
    )
    radius = props.get('r-card', '16rpx')
    radius_px = f'{float(radius.replace("rpx", "")) / 2:g}px' if 'rpx' in radius else radius
    return (
        f'<div class="theme-card {cls}">'
        f'<div class="tc-demo" style="border-radius:{radius_px};'
        f'background:linear-gradient(135deg,{props.get("m1")},{props.get("m2")})"></div>'
        f'<div class="tc-name">{THEME_LABEL.get(cls, cls)}</div>'
        f'<div class="tc-class">{cls}</div>'
        f'<div class="tc-sw">{swatches}</div>'
        f'</div>'
    )


def icon_card(name: str) -> str:
    return (
        f'<div class="ico-card"><div class="qz-ico qz-ico-m"><div class="qz-i qz-i-{name}"></div></div>'
        f'<code>qz-i-{name}</code></div>'
    )


def home_mock() -> str:
    """首页示意（用真实类名渲染，等价于页面视觉）"""
    grid = [
        ('ai', 'AI 员工'), ('toolbox', '工具箱'), ('station', '青智驿站'), ('workbench', '工作台'),
    ]
    chips = ['帮我做一份 PPT', '把视频压缩到 50MB', '找人拍毕业照']
    tools = [('office', 'AI PPT 生成', '一句话产出可编辑的 .pptx'), ('image', '图片压缩', '批量压缩不糊图'),
             ('video', '视频压缩', '压到指定体积'), ('pdf', 'PDF 合并', '多份合成一份')]
    return f'''
<div class="qz-page th-home mock">
  <div class="qz-deco">
    <div class="qz-fx">
      <div class="qz-blob qz-blob-a"></div>
      <div class="qz-blob qz-blob-b"></div>
      <div class="qz-dot qz-dot-a"></div>
      <div class="qz-dot qz-dot-c"></div>
    </div>
  </div>
  <div class="qz-content">
    <div class="hero">
      <div class="hero-hello">
        <div class="hero-hi">Hi，今天想做点什么？</div>
        <div class="hero-tip">说一句话，AI 帮你把活干完</div>
      </div>
      <div class="search-box">
        <div class="qz-i qz-i-search search-icon"></div>
        <div class="search-ph">告诉我你想完成什么…</div>
        <div class="search-ai">AI</div>
      </div>
      <div class="chips">
        {''.join(f'<div class="chip tone-{i % 4}"><span class="chip-dot"></span><span class="chip-text">{c}</span></div>' for i, c in enumerate(chips))}
      </div>
    </div>
    <div class="container">
      <div class="status-card ok"><span class="status-pulse"></span>
        <span class="status-text">后端已连接 · v0.1.0 · DB up</span></div>
    </div>
    <div class="container">
      <div class="grid qz-card qz-card-grad qz-card-glow">
        <div class="qz-topline"></div>
        {''.join(f'<div class="grid-item"><div class="grid-ico qz-ico qz-ico-m qz-ico-float delay-{i}"><div class="qz-i qz-i-{k}"></div></div><div class="grid-name">{n}</div></div>' for i, (k, n) in enumerate(grid))}
      </div>
    </div>
    <div class="qz-sec"><div class="qz-sec-bar"></div><span class="qz-sec-title">热门工具</span>
      <span class="qz-sec-sub">大家都在用</span><span class="qz-sec-more">更多 ›</span></div>
    <div class="hscroll">
      {''.join(f'<div class="tool-card tone-{i % 4}"><div class="tool-ico qz-ico qz-ico-s"><div class="qz-i qz-i-{k}"></div></div><div class="tool-name">{n}</div><div class="tool-desc">{d}</div><div class="tool-meta"><span class="tool-free">免费</span><span class="tool-count">128 次</span></div></div>' for i, (k, n, d) in enumerate(tools))}
    </div>
    <div class="qz-sec"><div class="qz-sec-bar"></div><span class="qz-sec-title">热门需求</span></div>
    <div class="container">
      <div class="task-card qz-card qz-card-glow qz-card-bar">
        <div class="task-row"><span class="task-title">毕业季跟拍摄影</span><span class="task-budget">¥300</span></div>
        <div class="task-desc">6 月中旬，拍 2 小时，需要会修图，地点在本部校区</div>
        <div class="task-foot"><div class="task-tags"><span class="task-tag">摄影</span><span class="task-tag">修图</span></div>
        <span class="task-apply">12 人报名</span></div>
      </div>
    </div>
  </div>
  <div class="float-ai"><div class="float-ring"></div><div class="float-ring float-ring-2"></div>
    <div class="qz-i qz-i-ai float-ico"></div></div>
</div>'''


def mine_mock() -> str:
    menu = [('files', '我的文件', 'AI 生成的文件都在这里'), ('orders', '我的订单', '担保交易与履约进度'),
            ('wallet', '钱包与结算', '余额、冻结与提现'), ('credit', '信用与评价', '信用分与评价记录')]
    stats = [('96', '信用分'), ('1280', '积分'), ('7', '完成单数'), ('¥42', '余额')]
    return f'''
<div class="qz-page th-mine mock">
  <div class="qz-deco"><div class="qz-fx">
    <div class="qz-blob qz-blob-a"></div><div class="qz-blob qz-blob-b"></div>
    <div class="qz-dot qz-dot-a"></div></div></div>
  <div class="qz-content">
    <div class="profile">
      <div class="profile-deco"><div class="p-blob p-blob-a"></div><div class="p-blob p-blob-b"></div>
        <div class="p-dot p-dot-a"></div></div>
      <div class="qz-shine qz-shine-slow"></div>
      <div class="profile-top">
        <div class="avatar-ring"><div class="avatar avatar-ph"><div class="qz-i qz-i-mine avatar-ico"></div></div></div>
        <div class="profile-info">
          <div class="profile-name">青智同学</div>
          <div class="profile-sub">计算机学院 · 大二</div>
        </div>
      </div>
      <div class="profile-stats">
        {''.join(f'<div class="stat"><div class="stat-num">{v}</div><div class="stat-label">{k}</div></div>' for v, k in stats)}
      </div>
      <div class="badges">
        <div class="badge badge-on"><div class="qz-i qz-i-check badge-ico"></div><span>学生认证</span></div>
        <div class="badge"><span>未认证服务者</span></div>
      </div>
      <div class="profile-flow qz-flow"></div>
    </div>
    <div class="menu-group qz-card">
      {''.join(f'<div class="menu-item qz-item qz-item-line"><div class="qz-ico qz-ico-s"><div class="qz-i qz-i-{k}"></div></div><div class="menu-main"><div class="menu-label">{n}</div><div class="menu-desc">{d}</div></div><span class="menu-arrow">›</span></div>' for k, n, d in menu)}
    </div>
  </div>
</div>'''


def station_mock() -> str:
    cats = [('star', '全部'), ('photo', '摄影摄像'), ('design', 'PPT设计'), ('code', '编程'), ('errand', '跑腿')]
    tasks = [('毕业季跟拍摄影', '¥300', '6 月中旬，拍 2 小时，需要会修图', ['摄影', '修图'], 12),
             ('社团招新海报设计', '¥120', 'A3 海报 + 朋友圈长图，3 天内交付', ['设计'], 8)]
    return f'''
<div class="qz-page th-station mock">
  <div class="qz-deco"><div class="qz-fx">
    <div class="qz-blob qz-blob-a"></div><div class="qz-dot qz-dot-a"></div></div></div>
  <div class="qz-content">
    <div class="head">
      <div class="head-row">
        <div class="qz-ico qz-ico-l qz-ico-float"><div class="qz-i qz-i-station"></div></div>
        <div class="head-main"><div class="head-title">青智驿站</div>
          <div class="head-sub">把需求交给同学，把服务卖出去</div></div>
        <div class="head-btn"><div class="qz-i qz-i-plus head-btn-ico"></div><span>发布</span></div>
      </div>
      <div class="tabs">
        <div class="tab"><div class="qz-i qz-i-workbench tab-ico"></div><span>服务市场</span></div>
        <div class="tab tab-active"><div class="qz-i qz-i-orders tab-ico"></div><span>任务大厅</span></div>
      </div>
      <div class="search-box"><div class="qz-i qz-i-search search-icon"></div>
        <div class="search-input">搜索需求或服务</div></div>
      <div class="cats">
        {''.join(f'<div class="cat{" cat-active" if i == 0 else ""}"><div class="qz-i qz-i-{k} cat-ico"></div><span class="cat-text">{n}</span></div>' for i, (k, n) in enumerate(cats))}
      </div>
      <div class="head-flow qz-flow"></div>
    </div>
    <div class="list">
      {''.join(f'<div class="task qz-card qz-card-glow qz-card-bar"><div class="task-row"><span class="task-title">{t}</span><span class="task-budget">{b}</span></div><div class="task-desc">{d}</div><div class="task-tags">{"".join(f"<span class=tag>{x}</span>" for x in tags)}</div><div class="task-foot"><div class="task-status"><div class="task-status-dot"></div><span>招募中</span></div><span class="task-apply">{c} 人报名</span></div></div>' for t, b, d, tags, c in tasks)}
    </div>
  </div>
  <div class="fab"><div class="fab-ring"></div><div class="qz-i qz-i-plus fab-ico"></div><span class="fab-text">发布需求</span></div>
</div>'''


def build_html(css: str) -> str:
    themes = read_themes()
    icons = read_icons()

    theme_html = ''.join(theme_card(c, p) for c, p in themes)
    icon_html = ''.join(icon_card(n) for n in icons)

    deco = [
        ('qz-flow', '流线（行进虚线）'), ('qz-flow qz-flow-rev', '流线·反向'), ('qz-flow qz-flow-thick', '流线·加粗'),
        ('qz-water', '流水光效（条纹）'), ('qz-wave', '水波（扇贝曲线）'), ('qz-wave qz-wave-up', '水波·上翻'),
        ('qz-curve', '动态曲线（双弧错位）'),
    ]
    deco_html = ''.join(
        f'<div class="deco-item"><div class="{cls}"></div><code>{cls}</code><span>{label}</span></div>'
        for cls, label in deco
    )

    comps = '''
    <div class="demo-row">
      <div class="qz-card" style="flex:1"><b>qz-card</b><p>基础柔影卡</p></div>
      <div class="qz-card qz-card-line" style="flex:1"><b>qz-card-line</b><p>描边卡</p></div>
      <div class="qz-card qz-card-tint" style="flex:1"><b>qz-card-tint</b><p>主题浅底卡</p></div>
    </div>
    <div class="demo-row">
      <div class="qz-card qz-card-grad qz-card-glow" style="flex:1"><b>qz-card-grad</b><p>渐变卡 + 彩色柔影</p></div>
      <div class="qz-card qz-card-glow qz-card-bar" style="flex:1"><b>qz-card-bar</b><p>左侧彩条卡</p></div>
    </div>
    <div class="demo-row" style="align-items:center">
      <span class="qz-chip">qz-chip</span>
      <span class="qz-chip qz-chip-on">qz-chip-on</span>
      <span class="qz-chip qz-chip-ghost">qz-chip-ghost</span>
      <span class="qz-tag">qz-tag</span>
      <span class="qz-tag qz-tag-ai">AI</span>
      <span class="qz-tag qz-tag-hot">热门</span>
    </div>
    <div class="demo-row" style="align-items:center">
      <div class="qz-btn-main" style="width:200px">qz-btn-main</div>
      <div class="qz-btn-sub" style="width:160px">qz-btn-sub</div>
      <div class="qz-btn-plain" style="width:160px">qz-btn-plain</div>
      <div class="qz-grad-text" style="font-size:20px;font-weight:800">渐变文字</div>
    </div>
    <div class="demo-row">
      <div class="qz-item qz-item-line" style="flex:1"><div class="qz-ico qz-ico-s"><div class="qz-i qz-i-wallet"></div></div><div class="qz-item-main"><span class="qz-item-title">qz-item</span><span class="qz-item-desc">通用列表项</span></div><span class="qz-item-arrow">›</span></div>
      <div style="flex:1"><div class="qz-skeleton qz-skeleton-line"></div><div class="qz-skeleton qz-skeleton-line qz-skeleton-line-short"></div><div class="qz-skeleton qz-skeleton-line"></div></div>
    </div>
    <div class="demo-row">
      <div class="qz-empty" style="flex:1">
        <div class="qz-empty-ico qz-ico qz-ico-xl qz-ico-float"><div class="qz-i qz-i-empty"></div></div>
        <span class="qz-empty-title">qz-empty</span>
        <span class="qz-empty-text">所有空态页共用这一套，气质才统一</span>
        <div class="qz-empty-flow qz-flow"></div>
        <div class="qz-btn-main" style="width:180px;margin:0 auto">主操作</div>
      </div>
    </div>'''

    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>青智校园 · 小程序视觉规范预览</title>
<style>
{css}

/* ---------- 预览页自身的排版（不属于小程序样式） ---------- */
body {{
  margin: 0; padding: 32px 40px 80px;
  background: #eef1f7; color: #101828;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
}}
h1 {{ font-size: 30px; margin: 0 0 6px; letter-spacing: .5px; }}
.lead {{ color: #667085; font-size: 14px; margin: 0 0 8px; }}
h2 {{ font-size: 20px; margin: 46px 0 6px; padding-left: 12px;
      border-left: 6px solid #00B8A9; line-height: 1.2; }}
h2 small {{ color: #98A2B3; font-size: 13px; font-weight: 400; margin-left: 10px; }}
.grid-themes {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 12px; }}
.theme-card {{ background: #fff; border-radius: 14px; padding: 12px;
  box-shadow: 0 2px 6px rgba(16,24,40,.04), 0 8px 22px rgba(16,24,40,.06); }}
.tc-demo {{ height: 44px; margin-bottom: 8px;
  box-shadow: inset 0 2px 0 rgba(255,255,255,.6); }}
.tc-name {{ font-size: 14px; font-weight: 600; }}
.tc-class {{ font-size: 11px; color: #98A2B3; margin-bottom: 8px; }}
.tc-sw {{ display: flex; gap: 4px; }}
.sw {{ width: 16px; height: 16px; border-radius: 5px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.06); }}
.grid-icons {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }}
.ico-card {{ background: #fff; border-radius: 14px; padding: 14px 8px; text-align: center;
  box-shadow: 0 2px 6px rgba(16,24,40,.04), 0 8px 22px rgba(16,24,40,.06); }}
.ico-card .qz-ico {{ margin: 0 auto 8px; }}
.ico-card code {{ font-size: 10.5px; color: #667085; word-break: break-all; }}
.deco-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }}
.deco-item {{ background: #fff; border-radius: 14px; padding: 14px; position: relative; overflow: hidden;
  box-shadow: 0 2px 6px rgba(16,24,40,.04), 0 8px 22px rgba(16,24,40,.06); }}
.deco-item > div {{ height: 22px; margin-bottom: 10px; }}
.deco-item code {{ font-size: 11px; color: #475467; display: block; }}
.deco-item span {{ font-size: 11.5px; color: #98A2B3; }}
.demo-row {{ display: flex; gap: 12px; margin-bottom: 12px; }}
.demo-row .qz-card {{ margin-bottom: 0; }}
.demo-row b {{ font-size: 13px; }} .demo-row p {{ margin: 4px 0 0; font-size: 11.5px; color: #98A2B3; }}
.mock-row {{ display: flex; gap: 22px; flex-wrap: wrap; align-items: flex-start; }}
.phone {{ width: 375px; height: 660px; overflow: hidden; border-radius: 26px;
  background: #F5F7FA; box-shadow: 0 18px 50px rgba(16,24,40,.18); position: relative; }}
.mock {{ min-height: 660px; font-size: 14px; }}
.mock .hero {{ padding: 28px 16px 16px; }}
.mock .head {{ padding: 22px 16px 8px; }}
.mock .list {{ padding: 8px 16px; }}
.mock .container {{ padding: 0 16px; }}
.mock .hscroll {{ padding: 0 16px; white-space: nowrap; overflow: hidden; }}
.mock .qz-card {{ margin-bottom: 8px; }}
.mock .qz-sec {{ padding: 12px 16px 6px; }}
.mock .chips {{ white-space: nowrap; overflow: hidden; }}
.mock .tool-card {{ margin-bottom: 8px; }}
.note {{ background: #fff; border-radius: 14px; padding: 14px 18px; font-size: 13px; color: #475467;
  box-shadow: 0 2px 6px rgba(16,24,40,.04), 0 8px 22px rgba(16,24,40,.06); line-height: 1.8; }}
.note code {{ background: #f2f4f7; padding: 1px 6px; border-radius: 5px; font-size: 12px; }}
</style>
</head>
<body>
<h1>青智校园 · 小程序视觉规范预览</h1>
<p class="lead">由 <code>scripts/dev/gen-visual-preview.py</code> 从 <code>apps/mp/styles/</code> 直接编译生成，
样式与小程序完全同源（rpx 已按 750 设计稿折半为 px）。</p>

<h2>一、模块主题色板 <small>{len(themes)} 套 · 主色家族统一，点缀色与形状各异</small></h2>
<div class="grid-themes">{theme_html}</div>

<h2>二、糖果图标库 <small>{len(icons)} 个 · 自带底色造型 + 白色图形 + 糖果高光</small></h2>
<div class="grid-icons">{icon_html}</div>

<h2>三、装饰元素 <small>流线 / 水波 / 曲线 / 流水光效</small></h2>
<div class="deco-grid">{deco_html}</div>

<h2>四、共享组件 <small>卡片 / 标签 / 按钮 / 列表项 / 空态 / 骨架</small></h2>
{comps}

<h2>五、页面示意 <small>用真实类名渲染，等价于页面视觉</small></h2>
<div class="mock-row">
  <div class="phone">{home_mock()}</div>
  <div class="phone">{station_mock()}</div>
  <div class="phone">{mine_mock()}</div>
</div>

<h2>六、使用说明</h2>
<div class="note">
  新增页面请照 <code>docs/dev/MP-VISUAL-SYSTEM.md</code> 的骨架写：<br>
  ① 根节点 <code>class="qz-page th-模块"</code>；② 装饰层 <code>.qz-deco &gt; .qz-fx</code>；
  ③ 内容包在 <code>.qz-content</code>；④ 取色只用 <code>var(--m1..--m4/--ms/--mt/--sh/--r-card)</code>；
  ⑤ 图标用 <code>.qz-i-xxx</code>；⑥ 动效只用现成类，不自己写 <code>@keyframes</code>。
</div>
</body>
</html>'''


def main() -> None:
    html = build_html(build_css())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding='utf-8')
    print(f'[ok] {OUT.relative_to(ROOT)}  ({len(html) / 1024:.1f} KB)')


if __name__ == '__main__':
    main()
