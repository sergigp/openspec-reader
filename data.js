// Reading a repo's openspec/ folder, on whichever machine it lives. No UI here.
//
// One shell script walks the folder and prints a line per thing, so a refresh is
// a single `exec` on a remote machine, and nothing but sh, git and awk is needed
// there: not the openspec CLI.
//   R  root
//   C  kind (active|archived)  name  done  total  docs (p, d, t)  why
//   S  kind  name  path of a spec delta, relative to the change
//   M  capability of a main spec

export const SCAN = String.raw`
dir=$1
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || {
  # No git, or no repo: the nearest folder up with an openspec/ in it.
  root=$dir
  while [ "$root" != / ] && [ -n "$root" ] && [ ! -d "$root/openspec" ]; do root=${"$"}{root%/*}; done
}
base="$root/openspec"
[ -d "$base" ] || exit 3
printf 'R\t%s\n' "$root"
change() {
  kind=$1; d=${"$"}{2%/}; name=${"$"}{d##*/}
  counts='0 0'; docs=''; why=''
  [ -f "$d/proposal.md" ] && {
    docs=p
    why=$(awk '/^#+[[:space:]]+Why/{f=1;next} f&&/^#/{exit} f&&NF{print;exit}' "$d/proposal.md" | tr '\t' ' ')
  }
  [ -f "$d/design.md" ] && docs="${"$"}{docs}d"
  [ -f "$d/tasks.md" ] && {
    docs="${"$"}{docs}t"
    counts=$(awk '/^[[:space:]]*[-*] \[[ xX]\]/{t++} /^[[:space:]]*[-*] \[[xX]\]/{n++} END{print n+0, t+0}' "$d/tasks.md")
  }
  printf 'C\t%s\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$name" "${"$"}{counts% *}" "${"$"}{counts#* }" "$docs" "$why"
  [ -d "$d/specs" ] && find "$d/specs" -type f -name '*.md' | sort | while IFS= read -r f; do
    printf 'S\t%s\t%s\t%s\n' "$kind" "$name" "${"$"}{f#"$d"/}"
  done
}
for d in "$base"/changes/*/; do
  [ -d "$d" ] || continue
  [ "${"$"}{d%/}" = "$base/changes/archive" ] && continue
  change active "$d"
done
for d in "$base"/changes/archive/*/; do
  [ -d "$d" ] && change archived "$d"
done
for f in "$base"/specs/*/spec.md; do
  [ -f "$f" ] || continue
  d=${"$"}{f%/spec.md}
  printf 'M\t%s\n' "${"$"}{d##*/}"
done
exit 0
`;

export const NO_OPENSPEC = 3;

export function parseScan(text) {
  const out = { root: "", active: [], archived: [], specs: [] };
  const byKey = new Map();
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f[0] === "R") out.root = f[1];
    else if (f[0] === "C") {
      const [, kind, name, done, total, docs, why] = f;
      const item = { kind, name, done: Number(done) || 0, total: Number(total) || 0, flags: docs ?? "", why: why ?? "", deltas: [] };
      byKey.set(`${kind}/${name}`, item);
      out[kind]?.push(item);
    } else if (f[0] === "S") byKey.get(`${f[1]}/${f[2]}`)?.deltas.push(f[3]);
    else if (f[0] === "M") out.specs.push({ kind: "spec", name: f[1], why: "", deltas: [], flags: "", done: 0, total: 0 });
  }
  out.active.sort((a, b) => a.name.localeCompare(b.name));
  // Archived folders start with their date: the newest first.
  out.archived.sort((a, b) => b.name.localeCompare(a.name));
  out.specs.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// What an entry shows, in reading order, as absolute paths on its machine.
export function docsOf(item, root) {
  if (item.kind === "spec") return [{ id: "spec", label: "Spec", path: `${root}/openspec/specs/${item.name}/spec.md` }];
  const dir = `${root}/openspec/changes/${item.kind === "archived" ? "archive/" : ""}${item.name}`;
  const docs = [];
  if (item.flags.includes("p")) docs.push({ id: "proposal", label: "Proposal", path: `${dir}/proposal.md` });
  if (item.flags.includes("d")) docs.push({ id: "design", label: "Design", path: `${dir}/design.md` });
  if (item.flags.includes("t")) docs.push({ id: "tasks", label: "Tasks", path: `${dir}/tasks.md` });
  for (const delta of item.deltas) docs.push({ id: delta, label: specLabel(delta), path: `${dir}/${delta}` });
  return docs;
}

// specs/auth/spec.md -> auth; a file named otherwise keeps its name.
export function specLabel(path) {
  const parts = path.replace(/^specs\//, "").split("/");
  return (parts.at(-1) === "spec.md" ? parts.slice(0, -1) : parts).join("/").replace(/\.md$/, "") || path;
}

// 2026-11-03-young-video-recheck -> { date, title }
export function titleOf(item) {
  const m = item.kind === "archived" ? /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(item.name) : null;
  return m ? { date: m[1], title: m[2] } : { date: "", title: item.name };
}

export function matches(item, filter) {
  if (!filter) return true;
  const text = `${item.name} ${item.why} ${item.deltas.join(" ")}`.toLowerCase();
  return filter.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.includes(w));
}

const STEP = /^\s*[-*]\s+\*\*(GIVEN|WHEN|THEN|AND|BUT)\*\*[:,]?\s*(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const clean = (lines) => lines.map((l) => l.replace(/^ {2}/, "")).join("\n").trim();

// A spec or delta as sections of requirements of scenarios, or null when it has
// no "### Requirement:" (then it's ordinary markdown). Every line lands somewhere:
// what isn't a known heading or a step stays as text of whatever it follows.
export function parseSpecDoc(text) {
  const doc = { intro: [], sections: [] };
  let section = null, req = null, scenario = null, step = null, fenced = false, found = false;
  const open = (title, op) => {
    section = { title, op, intro: [], requirements: [] };
    doc.sections.push(section);
    req = scenario = step = null;
  };
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,4})\s+(.*?)\s*$/.exec(line);
    const level = heading?.[1].length, title = heading?.[2] ?? "";
    const op = level === 2 ? /^(ADDED|MODIFIED|REMOVED|RENAMED)\b/.exec(title) : null;
    const requirement = level === 3 ? /^Requirement:\s*(.*)$/.exec(title) : null;
    const named = level === 4 ? /^Scenario:\s*(.*)$/.exec(title) : null;
    const stepped = fenced || !scenario ? null : STEP.exec(line);
    if (level === 1 && !section && !doc.intro.length) continue; // the tab names the document
    if (level === 2) open(op || title === "Requirements" ? "" : title, op?.[1] ?? null);
    else if (requirement) {
      if (!section) open("", null);
      found = true;
      req = { title: requirement[1], body: [], scenarios: [] };
      section.requirements.push(req);
      scenario = step = null;
    } else if (named && req) {
      scenario = { title: named[1], steps: [], notes: [] };
      req.scenarios.push(scenario);
      step = null;
    } else if (stepped) {
      step = { word: stepped[1], lines: [stepped[2]] };
      scenario.steps.push(step);
    } else if (step && line.trim()) step.lines.push(line);
    else if (scenario) (step ? step.lines : scenario.notes).push(line);
    else if (req) req.body.push(line);
    else (section ? section.intro : doc.intro).push(line);
  }
  if (!found) return null;
  return {
    intro: clean(doc.intro),
    sections: doc.sections.map((s) => ({
      title: s.title, op: s.op, intro: clean(s.intro),
      requirements: s.requirements.map((r) => ({
        title: r.title, body: clean(r.body),
        scenarios: r.scenarios.map((c) => ({
          title: c.title, notes: clean(c.notes),
          steps: c.steps.map((p) => ({ word: p.word, text: clean(p.lines) })),
        })),
      })),
    })),
  };
}

const TASK = /^[-*]\s+\[([ xX])\]\s+(?:(\d+(?:\.\d+)*)\.?\s+)?(.*)$/;
const VERIFY = /^([\s\S]*?)\s+(?:\*\*)?Verify:(?:\*\*)?\s+([\s\S]+)$/;

// A tasks.md as groups of tasks, or null when it has no checkboxes. As in
// parseSpecDoc, every line lands somewhere: indented lines belong to the task
// above, and other text stays where it was, between the tasks.
export function parseTasks(text) {
  const intro = [], groups = [];
  let group = null, task = null, note = null, fenced = false;
  const open = (title) => {
    const m = /^(\d+)\.\s+(.*)$/.exec(title);
    group = { number: m?.[1] ?? "", title: m?.[2] ?? title, items: [] };
    groups.push(group);
    task = note = null;
  };
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    const found = fenced ? null : TASK.exec(line);
    if (heading?.[1].length === 1 && !group && !intro.join("").trim()) continue; // the tab names the document
    if (heading) open(heading[2]);
    else if (found) {
      if (!group) open("");
      task = { done: found[1] !== " ", id: found[2] ?? "", lines: [found[3]] };
      group.items.push(task);
      note = null;
    } else if (task && (!line.trim() || /^\s/.test(line) || fenced)) task.lines.push(line);
    else if (!group) intro.push(line);
    else {
      task = null;
      if (!note) {
        note = { note: true, lines: [] };
        group.items.push(note);
      }
      note.lines.push(line);
    }
  }
  const out = groups.map((g) => {
    const items = g.items.map((item) => {
      const body = clean(item.lines);
      if (item.note) return { note: body };
      const split = VERIFY.exec(body);
      return { done: item.done, id: item.id, text: split?.[1] ?? body, verify: split?.[2] ?? "" };
    }).filter((item) => item.note !== "");
    const tasks = items.filter((item) => item.note === undefined);
    return { number: g.number, title: g.title, items, done: tasks.filter((x) => x.done).length, total: tasks.length };
  }).filter((g) => g.title || g.items.length);
  const total = out.reduce((n, g) => n + g.total, 0);
  if (!total) return null;
  return { intro: clean(intro), groups: out, done: out.reduce((n, g) => n + g.done, 0), total };
}

// Ordinary markdown cut at its "## " headings, each piece keeping its heading.
// What comes before the first heading is in no piece: it's only in the whole view.
export function markdownSections(text) {
  const sections = [];
  let section = null, fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^##\s+(.*?)\s*$/.exec(line);
    if (heading) {
      section = { title: heading[1], lines: [] };
      sections.push(section);
    }
    section?.lines.push(line);
  }
  return sections.map((s) => ({ title: s.title, text: s.lines.join("\n").trim() }));
}

// Spec entries to pick from: each titled section's text, then each requirement.
export function specOutline(spec) {
  return spec.sections.flatMap((s, section) => [
    ...(s.title || s.intro ? [{ title: s.title || s.op || "Notes", section, requirement: null }] : []),
    ...s.requirements.map((r, requirement) => ({ title: r.title, section, requirement })),
  ]);
}
