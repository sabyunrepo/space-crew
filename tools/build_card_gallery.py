"""Package reviewed original image files; does not modify image pixels."""
from pathlib import Path
from html import escape
import argparse
import csv
import hashlib
import json
import shutil
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DECK = ROOT / 'assets/cards/deck'
parser = argparse.ArgumentParser(description='검수본 또는 v1·v2 통합 최종 v3 패키지 생성')
parser.add_argument('--version', choices=['reviewed', 'v3'], default='reviewed')
args = parser.parse_args()
OUT = DECK / args.version
FINAL = args.version == 'v3'
SUITS = [('blue-hangyodon', '한교동', '파랑', 9), ('green-komodo', '코모도', '초록', 9), ('yellow-spongebob', '스폰지밥', '노랑', 9), ('black-tamama', '타마마', '검정', 9), ('white-rocket', '로켓', '흰색', 4)]
SCENES = {
 'blue-hangyodon': ['외벽 패널 정비', '냉각 호스 정리', '접시 안테나 교정', '광물 스캔', '탐사차 바퀴 정비', '항로 보정', '태양광 패널 설치', '화물 견인차 운전', '엔진 노즐 검사'],
 'green-komodo': ['산소 장치 수리', '높은 관수 밸브 조정', '로프 하강·광물 채집', '공기 필터 운반', '탐사차 하부 정비', '현미경 관찰', '기상 관측 기둥 설치', '종자 분류', '궤도 정원 로봇 제어'],
 'yellow-spongebob': ['제어 콘솔 수리', '압력 조절', '무중력 볼트 회수', '회로 납땜', '전망창 청소', '탐사차 전조등 조정', '로봇 배터리 교체', '외부 안테나 연결', '원자로 점검 완료'],
 'black-tamama': ['전력 배터리 교체', '에너지 커플러 운반', '연료 셀 진단', '선체 체결부 정비', '자이로스코프 조정', '퓨즈 비교', '달 지형 측량', '거꾸로 통신함 정비', '에너지 코어 검사'],
 'white-rocket': ['격납고 정비', '연료 보급', '달 기지 이륙', '심우주 항해'],
}

def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)

def image_info(path):
    raw = path.read_bytes()
    assert raw[:8] == b'\x89PNG\r\n\x1a\n', path
    size = struct.unpack('>II', raw[16:24])
    assert size == (1024, 1536), (path, size)
    return {'width': size[0], 'height': size[1], 'sha256': hashlib.sha256(raw).hexdigest()}

cards = []
for suit, name, color, count in SUITS:
    for rank in range(1, count + 1):
        key = f'{suit}-{rank}'
        candidates = [ROOT / 'assets/cards/sources/v3' / f'{key}.png', DECK / 'v2/index-fixed' / f'{key}.png', DECK / 'v2/playing' / f'{key}.png', DECK / 'v1/playing' / f'{key}.png']
        source = next((p for p in candidates if p.exists()), None)
        card = {'id': key, 'suit': suit, 'rank': rank, 'name_ko': name, 'color_ko': color, 'scene_ko': SCENES[suit][rank - 1], 'status': 'ready' if source else 'generation_blocked', 'front': None, 'back': 'common-back.png'}
        if source:
            target = OUT / 'playing' / f'{key}.png'
            copy(source, target)
            card.update(front=target.relative_to(OUT).as_posix(), source=source.relative_to(ROOT).as_posix(), **image_info(target))
            oldkey = key.replace('green-komodo', 'green-gecko')
            old = DECK / 'v1/playing' / f'{oldkey}.png'
            if not FINAL and old.exists() and old.read_bytes() != source.read_bytes():
                copy(old, OUT / 'previous' / f'{key}.png')
                card['previous'] = f'previous/{key}.png'
        cards.append(card)
copy(DECK / 'v2/common-back.png', OUT / 'common-back.png')
ready = [c for c in cards if c['status'] == 'ready']
assert len({c['sha256'] for c in ready}) == len(ready), 'Duplicate image files'
targets = [{'id': 'target-' + c['id'], 'playing_card_id': c['id'], 'front': c['front'], 'status': c['status']} for c in cards if c['suit'] != 'white-rocket']
manifest = {'generator': 'built-in image_gen', 'expected_playing': 40, 'ready_playing': len(ready), 'complete': len(ready) == 40, 'back': {'file': 'common-back.png', 'shared_by_all_playing_cards': True, **image_info(OUT / 'common-back.png')}, 'playing_cards': cards, 'target_cards': targets, 'target_note_ko': '목표 카드 36개는 대응하는 플레이 카드 그림을 공유합니다. 별도 그림 36장을 생성한 것이 아닙니다.', 'reminder_cards': {'count': 5, 'status': 'not_generated'}}
(OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
if FINAL:
    manifest.update(version='v3', selection_priority=['assets/cards/sources/v3', 'assets/cards/deck/v2/index-fixed', 'assets/cards/deck/v2/playing', 'assets/cards/deck/v1/playing'], missing_playing=[c['id'] for c in cards if c['status'] != 'ready'])
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    with (OUT / 'cards.csv').open('w', encoding='utf-8-sig', newline='') as f:
        fields = ['id', 'name_ko', 'color_ko', 'rank', 'scene_ko', 'status', 'front', 'source']
        writer = csv.DictWriter(f, fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(cards)

sections = []
for suit, name, color, count in SUITS:
    figures = []
    for c in [x for x in cards if x['suit'] == suit]:
        title = f"{name} {c['rank']}"
        if c['front']:
            visual = f'<a href="{c["front"]}"><img src="{c["front"]}" alt="{escape(title + ': ' + c["scene_ko"])}" width="1024" height="1536" loading="lazy"></a>'
        else:
            visual = '<div class="missing">생성 보류<span>이미지 도구 출력 검사 거절</span></div>'
        previous = f'<details><summary>기존 그림과 비교</summary><img src="{c["previous"]}" alt="{escape(title)} 이전 버전" width="1024" height="1536" loading="lazy"></details>' if c.get('previous') else ''
        figures.append(f'<article>{visual}<h3>{escape(title)}</h3><p>{escape(c["scene_ko"])}</p>{previous}</article>')
    sections.append(f'<section id="{suit}"><h2>{color} · {name}</h2><div class="grid">{"".join(figures)}</div></section>')
nav = ''.join(f'<a href="#{s}">{n}</a>' for s, n, _, _ in SUITS)
missing = ', '.join(str(c['rank']) for c in cards if c['status'] != 'ready')
status = f'앞면 {len(ready)}/40장 · 공통 뒷면 1장' + (f' · 스폰지밥 {missing}번 생성 보류' if missing else ' · 전체 완성')
page = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>스페이스 크루 카드 모음</title><style>
*{{box-sizing:border-box}}html{{scroll-behavior:smooth}}body{{margin:0;background:#0c1424;color:#eef3fc;font-family:system-ui,sans-serif;line-height:1.6}}main{{max-width:1420px;margin:auto;padding:32px 20px 80px}}h1{{font-size:clamp(26px,4vw,44px);margin-bottom:8px}}p{{color:#bccbe0}}nav{{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}}a{{color:#a7d9ff}}nav a{{background:#1c2d46;padding:8px 16px;border-radius:24px;text-decoration:none}}a:focus-visible,summary:focus-visible{{outline:3px solid #f8d34d;outline-offset:4px}}section{{margin-top:48px;scroll-margin-top:16px}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:24px}}article{{background:#142138;padding:12px;border-radius:18px;align-self:start}}img{{display:block;width:100%;height:auto;border-radius:14px}}h3{{margin:12px 0 2px}}article p{{margin:0 0 10px;font-size:14px}}summary{{cursor:pointer;padding:10px 0;color:#a7d9ff}}.back{{max-width:280px}}.missing{{aspect-ratio:2/3;border:1px dashed #71849f;border-radius:14px;display:flex;align-items:center;justify-content:center;flex-direction:column;color:#ffd686}}.missing span{{font-size:12px;margin-top:8px;color:#bdc7d5}}@media(max-width:520px){{main{{padding:20px 12px}}.grid{{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}}article{{padding:7px}}h3{{font-size:16px}}article p{{font-size:12px}}}}
</style></head><body><main><h1>스페이스 크루 카드 모음</h1><p>{status}</p><p>카드를 누르면 원본 크기로 볼 수 있습니다. 수정한 카드는 ‘기존 그림과 비교’를 펼쳐 확인하세요.</p><nav>{nav}<a href="#back">뒷면</a></nav>{''.join(sections)}<section id="back"><h2>공통 뒷면</h2><p>모든 플레이 카드가 같은 뒷면을 사용합니다.</p><a class="back" style="display:block" href="common-back.png"><img src="common-back.png" alt="남색 우주와 흰 로켓, 네 종류 문양을 담은 공통 카드 뒷면" width="1024" height="1536" loading="lazy"></a></section></main></body></html>'''
if FINAL:
    page = page.replace('스페이스 크루 카드 모음', '스페이스 크루 · 최종 카드 v3').replace('수정한 카드는 ‘기존 그림과 비교’를 펼쳐 확인하세요.', 'v1·v2에서 채택한 최종 이미지 모음입니다.')
(OUT / 'index.html').write_text(page)
(OUT / 'README.ko.md').write_text(f'# 카드 이미지 검수본\n\n{status}\n\nindex.html을 브라우저에서 열면 앞면·뒷면과 이전 버전을 볼 수 있습니다. PNG는 모두1024×1536입니다. playing/는 채택본, previous/는 비교용 이전 그림입니다.\n\n목표 카드36개는 manifest에서 대응 앞면을 참조합니다. 리마인더5장은 아직 생성하지 않았습니다.\n\n숫자별 상황·배경·시점과 실제 프롬프트는 프로젝트 docs/card-design/에 보관되어 있습니다.\n')
if FINAL:
    completion_note = '앞면40장 전체가 준비되었습니다.' if len(ready) == 40 else '미완성 카드는 manifest에 generation_blocked, front: null로 표시했습니다.'
    (OUT / 'README.ko.md').write_text(f'# 최종 카드 v3\n\n{status}\n\nv1·v2에서 검수된 카드를 종류·숫자마다 하나씩 통합했습니다. 이름과 숫자 방향선 수정본을 우선 채택했습니다. 모든 PNG는1024×1536이며 원본 픽셀을 그대로 보존했습니다.\n\n- index.html: PC·모바일 대응 미리보기. 카드 클릭 시 원본 이미지\n- playing/: 최종 앞면{len(ready)}장\n- common-back.png: 공통 뒷면1장\n- manifest.json: 플레이 카드40개 정의, 이미지·출처·해시, 목표 카드36개 매핑\n- cards.csv: 카드별 목록과 채택한 원본 경로\n\n{completion_note} 목표 카드36개는 대응하는 앞면을 공유하며 별도 이미지 파일을 복제하지 않습니다. 리마인더5장은 아직 생성하지 않았습니다.\n\nv3는 독립적으로 열 수 있는 최종 통합 패키지입니다. v1·v2와 이전 검수본은 프로젝트에 보존했습니다. 다시 만들기: python3 tools/build_card_gallery.py --version v3\n')
archive = DECK / ('cards-v3.zip' if FINAL else 'cards-reviewed.zip')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as z:
    for path in sorted(OUT.rglob('*')):
        if path.is_file():
            z.write(path, ('cards-v3/' if FINAL else 'cards-reviewed/') + path.relative_to(OUT).as_posix())
print(json.dumps({'ready': len(ready), 'expected': 40, 'missing': [c['id'] for c in cards if c['status'] != 'ready'], 'gallery': str(OUT / 'index.html'), 'zip': str(archive)}, ensure_ascii=False))
