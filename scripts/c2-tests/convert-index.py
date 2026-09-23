# C2 batch 6 (2026-09-23): the one-off conversion of every inline on* handler in index.html
# to the data-action dispatcher (handlers live in js/index-actions.js). Kept for the record
# and for the differential test:
#
#   python3 scripts/c2-tests/convert-index.py ORIG.html OUT.html [--instrument] [--report r.json]
#
# --instrument first tags every element that carries an inline handler with data-h="k" and
# writes that tagged original next to OUT as OUT.orig.html, so index-diff-test.js can pair
# the elements of both pages.
import re, json, sys
args = [a for a in sys.argv[1:] if not a.startswith('--')]
IN, OUTF = args[0], args[1]
REPORT = sys.argv[sys.argv.index('--report') + 1] if '--report' in sys.argv else None
src = open(IN).read()
if '--instrument' in sys.argv:
    _k = [0]
    def _tag(m):
        t = m.group(0)
        if re.search(r'\son[a-z]+="', t):
            _k[0] += 1
            return re.sub(r'^(<[a-zA-Z][\w-]*)', r'\1 data-h="%d"' % _k[0], t)
        return t
    src = re.sub(r'<[a-zA-Z][^<>]*>', _tag, src, flags=re.S)
    open(OUTF.rsplit('.', 1)[0] + '.orig.html', 'w').write(src)
ATTR = re.compile(r'(\s)(on[a-z]+)="([^"]*)"')
TOK = re.compile(r"\s*('([^'\\]*)'|-?\d+(?:\.\d+)?|this|event|true|false|null)\s*(,|$)")
SIMPLE = re.compile(r"^([A-Za-z_$][\w$]*)\((.*)\)$")
OVERLAY = re.compile(r"^if\s*\(\s*event\.target\s*===\s*this\s*\)\s*([A-Za-z_$][\w$]*)\(\)$")
SPECIAL = {
  ('onclick', "goToHome(); return false;"): 'data-action="go-home"',
  ('onclick', "showDisclaimerModal(); return false;"): 'data-action="show-disclaimer"',
  ('onclick', "switchTab('delegation'); if (typeof delegFilterMine === 'function') delegFilterMine();"): 'data-action="deleg-tile"',
  ('oninput', "formatStakingInput(this); renderStakingResults()"): 'data-input="staking-input"',
  ('oninput', "this.dataset.userSet='1'; renderStakingResults()"): 'data-input="staking-price-input"',
  ('oninput', "formatCompoundInput(this); calculateCompoundGrowth()"): 'data-input="compound-input"',
  ('oninput', "this.dataset.userSet='1'; calculateBreakeven()"): 'data-input="breakeven-price-input"',
  ('onclick', "event.stopPropagation()"): 'data-action="stop"',
  # closePerfExplainerModal(event) compares event.target with event.currentTarget, which is
  # document under delegation — use the overlay rule instead (same behaviour).
  ('onclick', "closePerfExplainerModal(event)"): 'data-action="overlay-close" data-fn="closePerfExplainerModal"',
  ('onload', "this.media='all'"): 'data-async-css',
}
EV = {  # handler attr -> (dispatch attr, generic action name, dataset key prefix)
  'onclick':  ('data-action', 'call',        'data-'),
  'oninput':  ('data-input',  'call-input',  'data-input-'),
  'onchange': ('data-change', 'call-change', 'data-change-'),
  'onerror':  ('data-onerror','call-error',  'data-error-'),
  'onfocus':  (None, None, 'data-focus-'),
  'onblur':   (None, None, 'data-blur-'),
}
fns = set(); count = 0; log = []
# Elements whose on* PROPERTY is reassigned by js (confirm buttons turn into "Close" after a
# transaction; compare slots toggle focusCompareSearch/null). A data-action here would fire IN
# ADDITION to the reassigned property (e.g. re-submit a transaction), so these keep property
# semantics: the attribute is dropped and js/index-actions.js assigns the same initial .onclick.
PROPERTY_IDS = ['mergeStakesConfirmBtn', 'splitStakeConfirmBtn', 'undelegateConfirmBtn', 'redelegateConfirmBtn',
  'withdrawStakeConfirmBtn', 'sendConfirmBtn', 'createStakeConfirmBtn', 'setWithdrawAuthorityBtn', 'setStakeAuthorityBtn',
  'withdrawConfirmBtn', 'commissionConfirmBtn', 'identityConfirmBtn', 'changeVoteAuthorityBtn',
  'compareSlot0', 'compareSlot1', 'compareSlot2', 'compareSlot3']
props = {}
TAG = re.compile(r'<[a-zA-Z][^<>]*?\sid="([^"]+)"[^<>]*>', re.S)
def strip_props(src):
    def fix(m):
        tag, id_ = m.group(0), m.group(1)
        if id_ not in PROPERTY_IDS: return tag
        hs = re.findall(r'\s(on[a-z]+)="([^"]*)"', tag)
        assert len(hs) == 1 and hs[0][0] == 'onclick', (id_, hs)
        sm = SIMPLE.match(hs[0][1].strip().rstrip(';'))
        assert sm and sm.group(2).strip() == '', (id_, hs)
        props[id_] = sm.group(1)
        return re.sub(r'\sonclick="[^"]*"', '', tag)
    return TAG.sub(fix, src)
def parse_args(s):
    out = []; pos = 0; s = s.strip()
    if not s: return out
    while pos < len(s):
        m = TOK.match(s, pos)
        if not m or m.end() == pos: raise ValueError('bad args: ' + s)
        t = m.group(1)
        if t.startswith("'"): out.append(m.group(2))
        elif t == 'this': out.append({'$': 'el'})
        elif t == 'event': out.append({'$': 'event'})
        elif t in ('true', 'false', 'null'): out.append(json.loads(t))
        else: out.append(json.loads(t))
        pos = m.end()
    return out
def conv(m):
    global count
    ws, ev, code = m.group(1), m.group(2), m.group(3)
    code_s = code.strip()
    count += 1
    if (ev, code_s) in SPECIAL:
        new = SPECIAL[(ev, code_s)]
        if 'data-fn="' in new: fns.add(re.search(r'data-fn="(\w+)"', new).group(1))
    elif ev == 'onclick' and OVERLAY.match(code_s):
        fn = OVERLAY.match(code_s).group(1); fns.add(fn)
        new = f'data-action="overlay-close" data-fn="{fn}"'
    else:
        sm = SIMPLE.match(code_s.rstrip(';').strip())
        if not sm or ev not in EV: raise ValueError(f'unhandled {ev}="{code}"')
        fn, args = sm.group(1), parse_args(sm.group(2)); fns.add(fn)
        dattr, action, pre = EV[ev]
        parts = [f'{dattr}="{action}"'] if dattr else []
        parts.append(f'{pre}fn="{fn}"')
        if args:
            j = json.dumps(args, separators=(',', ':'))
            assert "'" not in j
            parts.append(f"{pre}args='{j}'")
        new = ' '.join(parts)
    log.append((ev, code_s, new))
    return ws + new
src = strip_props(src)
assert sorted(props) == sorted(PROPERTY_IDS), set(PROPERTY_IDS) - set(props)
out = ATTR.sub(conv, src)
# load the handler file right after core.js
tag = '  <script src="js/core.js"></script>\n'
assert out.count(tag) == 1
out = out.replace(tag, tag + '  <script src="js/index-actions.js"></script>\n')
open(OUTF, 'w').write(out)
if REPORT: json.dump({'props': props, 'count': count, 'fns': sorted(fns), 'log': log}, open(REPORT, 'w'), indent=1)
print(count, 'handlers +', len(props), 'property;', len(fns), 'functions')
