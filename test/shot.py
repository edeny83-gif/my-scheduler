import sys
from playwright.sync_api import sync_playwright
root = '/home/claude/pc/my-scheduler-desktop'
WALL = "html{background:linear-gradient(160deg,#2c5364 0%,#203a43 45%,#6b8f71 100%)!important}"
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 760, 'height': 700})
    pg.add_init_script(path=f'{root}/test/mock-api.js')
    pg.goto(f'file://{root}/src/index.html'); pg.add_style_tag(content=WALL); pg.wait_for_timeout(600)
    pg.screenshot(path='/tmp/w1.png')
    # 투명도 변경이 실제로 반영되는지
    before = pg.evaluate("getComputedStyle(document.getElementById('panel')).backgroundColor")
    pg.evaluate("api.updateSettings({bgOpacity: 0.85})"); pg.wait_for_timeout(200)
    after = pg.evaluate("getComputedStyle(document.getElementById('panel')).backgroundColor")
    print('bg before/after:', before, '->', after)
    pg.screenshot(path='/tmp/w2.png')
    pg.evaluate("api.updateSettings({bgOpacity: 0.35})")
    # 입력창
    pg.click('#add'); pg.wait_for_timeout(200); pg.screenshot(path='/tmp/w3.png')
    pg.fill('#t', '테스트 일정'); pg.click('#save'); pg.wait_for_timeout(300)
    print('dialog open after save:', pg.evaluate("document.getElementById('form').open"))
    print('errors:', pg.evaluate("document.getElementById('ferr').textContent"))
    # 전체 화면 크기
    pg.set_viewport_size({'width': 1500, 'height': 900}); pg.wait_for_timeout(300); pg.screenshot(path='/tmp/w4.png')
    # 설정창
    s = b.new_page(viewport={'width': 520, 'height': 1900})
    s.add_init_script(path=f'{root}/test/mock-api.js')
    s.goto(f'file://{root}/src/settings.html'); s.wait_for_timeout(500); s.screenshot(path='/tmp/s1.png')
    b.close()
