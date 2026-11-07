// Mermaid blocks in the documents, drawn as pictures. Herdr's markdown shows them as code,
// so mermaid-cli (mmdc) renders each one to a PNG on this machine (the text may come from
// another one) into .cache/, named by its source and theme. Any diagram type mmdc knows.
// Needs `mmdc` on PATH: npm i -g @mermaid-js/mermaid-cli. With Chrome or Chromium installed,
// PUPPETEER_SKIP_DOWNLOAD=1 is fine: the render finds the browser and points mmdc at it
// ($PUPPETEER_EXECUTABLE_PATH wins). With neither, mmdc uses puppeteer's own download.

import { appHome, exec } from "herdr";

export const MISSING = 127;
const SCALE = 2; // rendered at 2x, shown at 1x: sharp on retina

const FENCE = /^```mermaid[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

// Markdown and diagrams, in order: [{ md }, { mermaid }, …].
export function splitMermaid(text) {
  if (!text || !text.includes("```mermaid")) return [{ md: text }];
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    if (m.index > last) parts.push({ md: text.slice(last, m.index) });
    parts.push({ mermaid: m[1].trimEnd() });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ md: text.slice(last) });
  return parts.filter((p) => p.mermaid !== undefined || p.md.trim());
}

// FNV-1a, 32 bits: a file name, not a secret.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Herdr's theme colours are hex; a light background gets mermaid's light theme.
export function isDark(background) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(background ?? "");
  if (!m) return true;
  const [r, g, b] = m.slice(1, 4).map((x) => parseInt(x, 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

// $1 output png, $2 source, $3 theme, $4 scale. Prints its IHDR size bytes.
const RENDER = String.raw`
out="$1"
if [ ! -s "$out" ]; then
  command -v mmdc >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"
  command -v mmdc >/dev/null 2>&1 || exit 127
  mkdir -p "$(dirname "$out")" || exit 1
  in="$out.$$.mmd"; tmp="$out.$$.png"
  printf '%s\n' "$2" > "$in"
  cfg=; chrome=$PUPPETEER_EXECUTABLE_PATH
  if [ -z "$chrome" ]; then
    for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
             "/Applications/Chromium.app/Contents/MacOS/Chromium" \
             google-chrome google-chrome-stable chromium chromium-browser; do
      case $c in /*) ;; *) c=$(command -v "$c" 2>/dev/null) || continue ;; esac
      [ -x "$c" ] && { chrome=$c; break; }
    done
  fi
  if [ -n "$chrome" ]; then
    cfg="$out.$$.json"
    printf '{"executablePath":"%s","headless":"shell"}\n' "$chrome" > "$cfg"
    mmdc -q -i "$in" -o "$tmp" -t "$3" -b transparent -s "$4" -p "$cfg" >&2
  else
    mmdc -q -i "$in" -o "$tmp" -t "$3" -b transparent -s "$4" >&2
  fi
  rc=$?
  rm -f "$in" "$cfg"
  [ $rc -eq 0 ] && [ -s "$tmp" ] && mv "$tmp" "$out" || { rm -f "$tmp"; exit $(( rc ? rc : 1 )); }
fi
od -An -tu1 -j16 -N8 "$out"
`;

// The PNG's place in Herdr's app folder (what image() takes) and on disk.
export function diagramPaths(source, dark) {
  const name = `${hash(`${dark ? "dark" : "default"}\n${source}`)}.png`;
  const rel = `mods/openspec-reader/.cache/${name}`;
  return { rel, abs: `${appHome()}/${rel}` };
}

// -> { rel, abs, width, height } at 1x; rejects with { code, message }.
export async function renderDiagram(source, dark) {
  const { rel, abs } = diagramPaths(source, dark);
  const r = await exec("sh", ["-c", RENDER, "sh", abs, source, dark ? "dark" : "default", String(SCALE)]);
  if (r.code !== 0) {
    const message = r.code === MISSING ? "mmdc not found" : r.stderr.trim().split("\n").filter(Boolean).pop() || `mmdc exit ${r.code}`;
    throw { code: r.code, message };
  }
  // PNG IHDR: width and height, big-endian 32-bit.
  const b = r.stdout.trim().split(/\s+/).map(Number);
  const be = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { rel, abs, width: be(0) / SCALE, height: be(4) / SCALE };
}
