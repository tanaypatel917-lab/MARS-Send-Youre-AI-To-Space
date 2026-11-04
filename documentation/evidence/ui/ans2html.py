"""Renders tmux `capture-pane -e` ANSI captures to HTML for screenshots (fixture evidence)."""
import html, re, sys

BASE = ["#000000","#cd3131","#0dbc79","#e5e510","#2472c8","#bc3fbc","#11a8cd","#e5e5e5",
        "#666666","#f14c4c","#23d18b","#f5f543","#3b8eea","#d670d6","#29b8db","#ffffff"]
def x256(n):
    if n < 16: return BASE[n]
    if n < 232:
        n -= 16; v = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (v[n // 36], v[n // 6 % 6], v[n % 6])
    g = 8 + (n - 232) * 10; return "#%02x%02x%02x" % (g, g, g)

def convert(text, title):
    out, st = [], {}
    def span(s):
        if not s: return
        fg, bg = st.get("fg"), st.get("bg")
        if st.get("inv"): fg, bg = bg or "#101418", fg or "#d4d4d4"
        css = []
        if fg: css.append(f"color:{fg}")
        if bg: css.append(f"background:{bg}")
        if st.get("bold"): css.append("font-weight:bold")
        if st.get("dim"): css.append("opacity:.6")
        if st.get("strike"): css.append("text-decoration:line-through")
        out.append(f'<span style="{";".join(css)}">{html.escape(s)}</span>' if css else html.escape(s))
    pos = 0
    for m in re.finditer(r"\x1b\[([0-9;:]*)m", text):
        span(text[pos:m.start()]); pos = m.end()
        codes = [int(c) if c else 0 for c in re.split("[;:]", m.group(1) or "0")]
        i = 0
        while i < len(codes):
            c = codes[i]
            if c == 0: st = {}
            elif c == 1: st["bold"] = True
            elif c == 2: st["dim"] = True
            elif c == 7: st["inv"] = True
            elif c == 9: st["strike"] = True
            elif c == 22: st.pop("bold", None); st.pop("dim", None)
            elif c == 27: st.pop("inv", None)
            elif c == 29: st.pop("strike", None)
            elif c in (38, 48):
                key = "fg" if c == 38 else "bg"
                if codes[i + 1] == 2: st[key] = "#%02x%02x%02x" % tuple(codes[i + 2:i + 5]); i += 4
                else: st[key] = x256(codes[i + 2]); i += 2
            elif c == 39: st.pop("fg", None)
            elif c == 49: st.pop("bg", None)
            elif 30 <= c <= 37: st["fg"] = BASE[c - 30]
            elif 90 <= c <= 97: st["fg"] = BASE[c - 82]
            elif 40 <= c <= 47: st["bg"] = BASE[c - 40]
            i += 1
    span(text[pos:])
    return ("<!doctype html><meta charset=utf-8><style>body{margin:0;background:#101418}"
            "pre{margin:0;padding:12px;color:#d4d4d4;font:14px/1.25 'DejaVu Sans Mono','Noto Sans Mono',monospace}"
            "h1{margin:0;padding:6px 12px;font:12px sans-serif;color:#9aa;background:#1b2026}</style>"
            f"<h1>{html.escape(title)}</h1><pre>{''.join(out)}</pre>")

if __name__ == "__main__":
    src, dst, title = sys.argv[1:4]
    open(dst, "w").write(convert(open(src, encoding="utf-8").read(), title))
