// OpenSpec: the changes and specs of the repo you're in, in the side panel. Read-only.
// Follows the focused terminal. Click the filter, then type to filter, ↑ ↓ for the
// entry, ← → for its document, shift+← → for Active, Specs and Archived. Works on
// any machine Herdr reaches; see data.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover, TextView } from "gpui-base";
import { exec, focused, layout, nextCommand, panes, readTextFile, spaces, theme } from "herdr";
import { NO_OPENSPEC, SCAN, docsOf, matches, markdownSections, parseScan, parseSpecDoc, parseTasks, specOutline, titleOf } from "./data.js";

const REFRESH_MS = 10000;
// This copy stays alive while the panel is closed: looking costs nothing, the
// scan only runs while the panel shows it.
const TICK_MS = 500;
// What a place's view is: kept when leaving it, so coming back shows it at once.
const PLACE = ["data", "state", "error", "tab", "at", "doc", "texts", "section", "sectionOf"];
const BAR_W = 96;
// A scroll area stretches to any height it's allowed, so the Active list is only
// one when its rows wouldn't fit; shorter, it's as tall as they are.
const LIST_ROWS = 4;
const LIST_H = 260;
const READ_W = 640; // a comfortable line length; wider panels centre the document
const TABS = [
  { id: "active", label: "Active" },
  { id: "specs", label: "Specs" },
  { id: "archived", label: "Archived" },
];

// The tab above already names the document: its opening title only repeats that.
const withoutTitle = (text) => text.replace(/^\s*#[ \t][^\n]*\n+/, "");

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function visible() {
  const panel = find(layout(), "panel");
  return Boolean(panel && !panel.hidden && find(panel, "panel-body")?.active === "openspec");
}

// The focused terminal's folder and machine, as the Files panel reads them.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const machine = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { folder: pane?.cwd || f?.cwd || space?.folder || "", machine };
}

export default class OpenSpec extends View {
  init(_props, cx) {
    this.data = null;
    this.state = "loading"; // loading | ready | none | error
    this.error = "";
    this.filter = "";
    this.tab = "active";
    this.at = 0;
    this.doc = "proposal"; // kept across entries: reading tasks stays on tasks
    this.texts = new Map();
    this.machine = null;
    this.folder = "";
    this.places = new Map(); // JSON [machine, folder] -> its PLACE fields
    this.scanned = 0;
    this.picking = false; // the dropdown is open
    this.sectioning = false; // the section dropdown is open
    this.section = null; // the section shown alone, of the document this.sectionOf
    this.sectionOf = null;
    this.folds = new Map(); // task group -> folded by hand

    this.input = InputState.new({ placeholder: "Type to filter…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.loadDoc(cx);
      cx.notify();
    });

    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        this.act(await nextCommand(), cx);
        cx.notify();
      }
    });
  }

  // While shown: rescan on arriving at another folder, else every so often.
  tick(cx) {
    if (!visible()) return;
    const { folder, machine } = location();
    if (folder !== this.folder || machine !== this.machine) {
      const place = (m, f) => JSON.stringify([m, f]);
      this.places.set(place(this.machine, this.folder), Object.fromEntries(PLACE.map((k) => [k, this[k]])));
      this.folder = folder;
      this.machine = machine;
      Object.assign(this, this.places.get(place(machine, folder)) ?? {
        data: null, state: "loading", error: "", tab: "active", at: 0, doc: "proposal",
        texts: new Map(), section: null, sectionOf: null,
      });
      this.picking = this.sectioning = false;
      this.scanned = 0; // what it remembers shows now; this checks it's still right
      cx.notify();
    }
    if (Date.now() - this.scanned >= REFRESH_MS) this.refresh(cx);
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    this.scanned = Date.now();
    const { folder, machine } = this;
    cx.spawn(async (cx) => {
      const moved = () => folder !== this.folder || machine !== this.machine;
      try {
        const r = await exec("sh", ["-c", SCAN, "sh", folder], { on: machine });
        if (moved()) return void (this.busy = false);
        if (r.code === NO_OPENSPEC) this.state = "none";
        else if (r.code !== 0) {
          this.state = "error";
          this.error = r.stderr.trim().split("\n").pop() || `exit ${r.code}`;
        } else {
          const first = !this.data;
          this.data = parseScan(r.stdout);
          this.state = "ready";
          if (first && !this.data.active.length && this.data.archived.length) this.tab = "archived";
        }
      } catch (e) {
        if (moved()) return void (this.busy = false);
        this.state = "error";
        this.error = String(e.message ?? e);
      }
      this.busy = false;
      this.loadDoc(cx, true);
      cx.notify();
    });
  }

  shown() {
    return (this.data?.[this.tab] ?? []).filter((item) => matches(item, this.filter));
  }

  selected() {
    const list = this.shown();
    return list[Math.min(this.at, list.length - 1)] ?? null;
  }

  docs() {
    const item = this.selected();
    return item ? docsOf(item, this.data.root) : [];
  }

  // The document to show: the one last read, else the entry's first.
  currentDoc() {
    const docs = this.docs();
    return docs.find((d) => d.id === this.doc) ?? docs[0] ?? null;
  }

  loadDoc(cx, again = false) {
    const doc = this.currentDoc();
    if (!doc || (!again && this.texts.has(doc.path))) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(doc.path, { on: this.machine }).catch(() => null);
      if (text === this.texts.get(doc.path)) return;
      this.texts.set(doc.path, text);
      cx.notify();
    });
  }

  step(n) {
    const count = this.shown().length;
    if (count) this.at = Math.max(0, Math.min(count - 1, Math.min(this.at, count - 1) + n));
  }

  stepDoc(n) {
    const docs = this.docs();
    if (!docs.length) return;
    const at = Math.max(0, docs.findIndex((d) => d.id === this.currentDoc()?.id));
    this.doc = docs[(at + n + docs.length) % docs.length].id;
  }

  stepTab(n) {
    const at = TABS.findIndex((t) => t.id === this.tab);
    this.tab = TABS[(at + n + TABS.length) % TABS.length].id;
    this.at = 0;
    this.picking = false;
  }

  act(name, cx) {
    if (name === "next") this.step(1);
    else if (name === "prev") this.step(-1);
    else if (name === "doc-next") this.stepDoc(1);
    else if (name === "doc-prev") this.stepDoc(-1);
    else if (name === "tab-next") this.stepTab(1);
    else if (name === "tab-prev") this.stepTab(-1);
    else if (name === "refresh") this.refresh(cx);
    else return false;
    this.loadDoc(cx);
    return true;
  }

  tabButton(t, tab) {
    const on = this.tab === tab.id;
    const count = this.data?.[tab.id]?.filter((item) => matches(item, this.filter)).length;
    return h_flex().id(`tab-${tab.id}`).h(26).px(10).gap(6).items_center().rounded(6).cursor_pointer()
      .text_size(12.5)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected).font_medium())
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        this.tab = tab.id;
        this.at = 0;
        this.picking = false;
        this.loadDoc(cx);
        cx.notify();
      })
      .child(div().child(tab.label))
      .when(count !== undefined, (el) => el.child(div().text_color(t.dim).child(String(count))));
  }

  bar(t, item, height) {
    const whole = item.done === item.total;
    return div().h(height).rounded(height / 2).bg(t.background).overflow_hidden()
      .child(div().h_full().rounded(height / 2).bg(whole ? t.ansi2 : t.working).w(`${(100 * item.done) / item.total}%`));
  }

  // A task group's progress.
  progress(t, item) {
    return h_flex().flex_none().gap(8).items_center()
      .child(this.bar(t, item, 6).w(BAR_W))
      .child(div().text_size(12.5).text_color(t.muted).child(`${item.done}/${item.total}`));
  }

  // A whole change's progress: shown once, as wide as its row.
  overall(t, item) {
    return h_flex().w_full().gap(10).items_center()
      .child(this.bar(t, item, 10).flex_1().min_w(0))
      .child(div().flex_none().text_size(14).font_medium().text_color(t.foreground).child(`${item.done}/${item.total}`));
  }

  row(t, item, index, chosen) {
    const { date, title } = titleOf(item);
    return v_flex().id(`row-${item.kind}-${item.name}`).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .when(chosen, (el) => el.bg(t.selected))
      .when(!chosen, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        this.at = index;
        this.loadDoc(cx);
        cx.notify();
      })
      .child(h_flex().gap(8).items_center().justify_between()
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(title))
        .when(Boolean(date), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(date))))
      .when(item.total > 0 && item.kind === "active", (el) => el.child(div().pt(4).child(this.overall(t, item))));
  }

  docButton(t, doc, on) {
    return div().id(`doc-${doc.id}`).flex_none().px(9).py(4).rounded(6).cursor_pointer().text_size(12)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected).font_medium())
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        this.doc = doc.id;
        this.loadDoc(cx);
        cx.notify();
      })
      .child(doc.label);
  }

  // A button showing the choice, and a menu of `options`: { key, label, date?, chosen, pick }.
  dropdown(t, { id, open, onOpen, label, hint, options }) {
    const menu = v_flex().id(`${id}-options`).w(340).max_h(420).p(4).gap(1).rounded(8).overflow_y_scrollbar()
      .bg(t.popover).border_1().border_color(t.border).text_size(13)
      .children(options.map((o) => h_flex().id(`${id}-${o.key}`).flex_none().px(8).py(5).gap(8).items_center().rounded(6).cursor_pointer()
        .text_color(t.foreground)
        .when(o.chosen, (el) => el.bg(t.selected))
        .when(!o.chosen, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          o.pick(cx);
          onOpen(false);
          cx.notify();
        })
        .child(div().flex_1().min_w(0).truncate().child(o.label))
        .when(Boolean(o.date), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(o.date)))));
    const trigger = h_flex().id(`${id}-trigger`).h(32).w_full().px(10).gap(8).items_center().justify_between().rounded(7).cursor_pointer()
      .border_1().border_color(t.border).hover((s) => s.bg(t.hover)).text_size(13).text_color(t.foreground)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(hint)))
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).flex_none().text_color(t.dim));
    return Popover.new(id)
      .open(open)
      .on_open_change((value, cx) => {
        onOpen(value);
        cx.notify();
      })
      .trigger(trigger)
      .content(menu);
  }

  // Long lists (Archived, Specs) go in a dropdown, so the document gets the room.
  picker(t, list, at) {
    return this.dropdown(t, {
      id: "os-entry",
      open: this.picking,
      onOpen: (value) => { this.picking = value; },
      label: titleOf(list[at]).title,
      hint: `${at + 1}/${list.length}`,
      options: list.map((item, i) => ({
        key: `${item.kind}-${item.name}`,
        label: titleOf(item).title,
        date: titleOf(item).date,
        chosen: i === at,
        pick: (cx) => {
          this.at = i;
          this.loadDoc(cx);
        },
      })),
    });
  }

  // Herdr can't scroll to a heading in this content, so a section is shown alone.
  sectionPicker(t, titles, only) {
    const choose = (value) => (_cx) => {
      this.section = value;
      this.sectionOf = this.currentDoc()?.path;
    };
    return this.dropdown(t, {
      id: "os-section",
      open: this.sectioning,
      onOpen: (value) => { this.sectioning = value; },
      label: only === null ? "All sections" : titles[only],
      hint: only === null ? String(titles.length) : `${only + 1}/${titles.length}`,
      options: [
        { key: "all", label: "All sections", chosen: only === null, pick: choose(null) },
        ...titles.map((title, i) => ({ key: `s${i}`, label: title, chosen: i === only, pick: choose(i) })),
      ],
    });
  }

  // Parsed once per file version: the panel redraws far more often than files change.
  structured(doc, text) {
    if (this.parsed?.path !== doc.path || this.parsed.text !== text) {
      const value = doc.id === "tasks" ? parseTasks(text) : parseSpecDoc(text);
      const outline = doc.id === "tasks" && value ? value.groups.map((g) => ({ title: [g.number, g.title].filter(Boolean).join(". ") }))
        : value ? specOutline(value)
        : markdownSections(text);
      this.parsed = { path: doc.path, text, value, outline };
    }
    return this.parsed;
  }

  tasksView(t, tasks, path, only) {
    const finished = tasks.done === tasks.total;
    const md = (id, text, color = t.foreground, size = 14) => TextView.markdown(`${path}-${id}`, text).selectable(true).w_full().text_size(size).text_color(color);
    const task = (x, id) => h_flex().gap(8).items_start()
      .child(div().w(16).flex_none().pt(1).text_size(13).text_color(x.done ? t.ansi2 : t.muted).child(x.done ? "✓" : "○"))
      .when(Boolean(x.id), (el) => el.child(div().w(34).flex_none().pt(2).text_size(11.5).text_color(t.dim).child(x.id)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(md(`${id}-text`, x.text, x.done && !finished ? t.muted : t.foreground))
        .when(Boolean(x.verify), (el) => el.child(h_flex().gap(8).items_start()
          .child(div().flex_none().pt(2).text_size(10.5).font_medium().text_color(t.dim).child("VERIFY"))
          .child(div().flex_1().min_w(0).child(md(`${id}-verify`, x.verify, t.muted, 13))))));
    const group = (g, i) => {
      const key = `${path}#${i}`;
      // Finished groups start folded while there's work left, to leave what's left in view.
      const folded = only === null && (this.folds.get(key) ?? (!finished && g.total > 0 && g.done === g.total));
      return v_flex().gap(10).p(12).rounded(9).bg(t.raised).border_1().border_color(t.border)
        .child(h_flex().id(`group-${i}`).gap(8).items_center().cursor_pointer()
          .on_click((_e, cx) => {
            this.folds.set(key, !folded);
            cx.notify();
          })
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
          .when(Boolean(g.number), (el) => el.child(div().flex_none().text_size(13).text_color(t.dim).child(g.number)))
          .child(div().flex_1().min_w(0).text_size(16).font_medium().text_color(t.foreground).child(g.title))
          .when(g.total > 0, (el) => el.child(this.progress(t, g))))
        .when(!folded, (el) => el.children(g.items.map((item, n) => item.note !== undefined
          ? md(`g${i}-note-${n}`, item.note, t.muted)
          : task(item, `g${i}-t${n}`))));
    };
    return v_flex().w_full().gap(10)
      // On Active, the change's row above already shows this.
      .when(this.tab !== "active", (el) => el.child(this.overall(t, tasks)))
      .when(Boolean(tasks.intro), (el) => el.child(md("intro", tasks.intro, t.muted)))
      .children(tasks.groups.map(group).filter((_g, i) => only === null || i === only));
  }

  specView(t, spec, path, pick) {
    const OP = { ADDED: t.ansi2, MODIFIED: t.accent, REMOVED: t.ansi1, RENAMED: t.muted };
    const WORD = { WHEN: t.accent, THEN: t.ansi2 };
    const md = (id, text, size = 15) => TextView.markdown(`${path}-${id}`, text).selectable(true).w_full().text_size(size).text_color(t.foreground);
    const pill = (op) => div().flex_none().px(6).py(1).rounded(4).border_1().border_color(OP[op]).text_size(11).font_medium().text_color(OP[op]).child(op);
    const scenario = (c, id) => v_flex().gap(6).p(10).rounded(7).bg(t.background).border_1().border_color(t.border)
      .child(div().text_size(14).font_medium().text_color(t.foreground).child(c.title))
      .when(Boolean(c.notes), (el) => el.child(md(`${id}-notes`, c.notes, 14)))
      .children(c.steps.map((p, i) => h_flex().gap(8).items_start()
        .child(div().w(50).flex_none().pt(2).text_size(11.5).font_medium().text_color(WORD[p.word] ?? t.muted).child(p.word))
        .child(div().flex_1().min_w(0).child(md(`${id}-step-${i}`, p.text, 14)))));
    const requirement = (r, op, id) => v_flex().gap(10).p(12).rounded(9).bg(t.raised).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_start().justify_between()
        .child(div().flex_1().min_w(0).text_size(16).font_medium().text_color(t.foreground).child(r.title))
        .when(Boolean(op), (el) => el.child(pill(op))))
      .when(Boolean(r.body), (el) => el.child(md(`${id}-body`, r.body)))
      .children(r.scenarios.map((c, i) => scenario(c, `${id}-${i}`)));
    if (pick) {
      const s = spec.sections[pick.section], at = pick.requirement;
      if (at !== null) return v_flex().w_full().child(requirement(s.requirements[at], s.op, `s${pick.section}-r${at}`));
      return v_flex().w_full().gap(10)
        .when(Boolean(s.title), (el) => el.child(div().text_size(13.5).font_medium().text_color(t.muted).child(s.title)))
        .when(Boolean(s.op), (el) => el.child(h_flex().child(pill(s.op))))
        .when(Boolean(s.intro), (el) => el.child(md(`s${pick.section}-intro`, s.intro)));
    }
    return v_flex().w_full().gap(14)
      .when(Boolean(spec.intro), (el) => el.child(md("intro", spec.intro)))
      .children(spec.sections.map((s, i) => v_flex().gap(10)
        .when(Boolean(s.title), (el) => el.child(div().text_size(13.5).font_medium().text_color(t.muted).child(s.title)))
        .when(Boolean(s.op) && !s.requirements.length, (el) => el.child(h_flex().child(pill(s.op))))
        .when(Boolean(s.intro), (el) => el.child(md(`s${i}-intro`, s.intro)))
        .children(s.requirements.map((r, n) => requirement(r, s.op, `s${i}-r${n}`)))));
  }

  reader(t) {
    const item = this.selected();
    if (!item) return this.note(t, this.filter ? "Nothing matches the filter." : "Nothing here.");
    const doc = this.currentDoc();
    if (!doc) return this.note(t, "This change has no documents yet.");
    const text = this.texts.get(doc.path);
    const parsed = text ? this.structured(doc, text) : null;
    const value = parsed?.value;
    const outline = parsed?.outline ?? [];
    const only = this.sectionOf === doc.path && this.section < outline.length ? this.section : null;
    return v_flex().flex_1().min_w(0).min_h(0).gap(8)
      .when(this.docs().length > 1, (el) => el.child(h_flex().flex_none().gap(3).flex_wrap().children(this.docs().map((d) => this.docButton(t, d, d.id === doc.id)))))
      .when(outline.length > 1, (el) => el.child(this.sectionPicker(t, outline.map((o) => o.title), only)))
      .child(v_flex().id(`os-doc-${only ?? "all"}`).flex_1().min_h(0).items_center().overflow_y_scrollbar().px(12).py(6)
        .child(v_flex().w_full().max_w(READ_W).child(text === undefined
          ? div().text_size(12.5).text_color(t.dim).child("Loading…")
          : text === null
            ? div().text_size(12.5).text_color(t.dim).child(`Couldn't read ${doc.path}`)
            : value ? (doc.id === "tasks" ? this.tasksView(t, value, doc.path, only) : this.specView(t, value, doc.path, only === null ? null : outline[only]))
            : TextView.markdown(`md-${doc.path}-${only ?? "all"}`, only === null ? withoutTitle(text) : outline[only].text).selectable(true).text_size(15).text_color(t.foreground))));
  }

  note(t, text) {
    return v_flex().flex_1().min_w(0).px(10).items_center().justify_center().text_size(13).text_color(t.muted).child(text);
  }

  body(t) {
    if (this.state === "loading") return this.note(t, "Reading openspec/…");
    if (this.state === "none") return this.note(t, `No openspec/ folder in the repo at ${this.folder}`);
    if (this.state === "error") return this.note(t, `Couldn't read openspec/: ${this.error}`);
    const list = this.shown();
    const at = Math.min(this.at, list.length - 1);
    if (this.tab !== "active") {
      return v_flex().flex_1().min_h(0).gap(10)
        .when(list.length > 0, (el) => el.child(this.picker(t, list, at)))
        .child(this.reader(t));
    }
    return v_flex().flex_1().min_h(0).gap(12)
      .child(v_flex().id("os-list").flex_none().gap(2).pr(4)
        .when(list.length > LIST_ROWS, (el) => el.h(LIST_H).overflow_y_scrollbar())
        .children(list.map((item, i) => this.row(t, item, i, i === at))))
      .child(this.reader(t));
  }

  render() {
    const t = theme();
    const repo = this.data?.root.split("/").pop() ?? "";
    const where = [repo, this.machine].filter(Boolean).join(" · ");
    return v_flex().id("os-root").size_full().min_h(0).p(12).gap(10).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        const name = k === "down" ? "next"
          : k === "up" ? "prev"
          : k === "right" && !this.filter ? "doc-next"
          : k === "left" && !this.filter ? "doc-prev"
          : k === "shift-right" ? "tab-next"
          : k === "shift-left" ? "tab-prev"
          : null;
        if (!name) return;
        this.act(name, cx);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(36).flex_none().px(12).gap(10).items_center().rounded(9).border_1().border_color(t.border).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(where)))
      .child(h_flex().flex_none().gap(4).children(TABS.map((tab) => this.tabButton(t, tab))))
      .child(this.body(t));
  }
}
