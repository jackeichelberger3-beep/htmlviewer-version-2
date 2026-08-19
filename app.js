import { templates } from "./templates.js";
import { formatHTML, formatCSS, formatJS } from "./formatter.js";
import { isFoldMarker, parseFoldMarker, isFoldStart, findBlockEnd, applyFold, unfoldAt } from "./folding.js";

const LS_PROJECT = "htmlStudio.project.v1";
const LS_THEME = "htmlStudio.theme";
const LS_SNIPPETS = "htmlStudio.snippets.v1";

let _id = 1;
const makeTab = (name = "Untitled.html", data = { html: "", css: "", js: "" }, fileId = null) => ({
  id: _id++, name, html: data.html || "", css: data.css || "", js: data.js || "",
  pinned: false, editorTab: "html", fileId, folds: []
});

let tabs = [];
let activeId = null;
let logs = [];
let previewTimer = null;
let project = loadProject();
let expanded = {};
let snippets = loadSnippets();
let explorerView = "project";
let snippetEditId = null;
let searchOpen = false, searchQ = "", replaceQ = "", replaceOpen = false;
let searchOpts = { case: false, word: false, regex: false };
let searchResults = [], searchIdx = 0, searchTimer = null;

const $ = (id) => document.getElementById(id);
const root = $("root");
const tabbar = $("tabbar");
const editor = $("editor");
const editorHead = $("editorHead");
const activeNameEl = $("activeName");
const preview = $("preview");
const tplMenu = $("tplMenu");
const explorerBody = $("explorerBody");
const ctxMenu = $("ctxMenu");
const consoleBody = $("consoleBody");
const consoleEl = $("console");
const dropOverlay = $("dropOverlay");
const editorWrap = $("editorWrap");
const minimap = $("minimap");
const minimapPre = $("minimapPre");
const minimapVp = $("minimapVp");
const gutter = $("gutter");
const searchBar = $("searchBar");
const searchInput = $("searchInput");
const replaceInput = $("replaceInput");
const searchResultsEl = $("searchResults");
const searchCountEl = $("searchCount");

function loadProject() {
  try { const p = JSON.parse(localStorage.getItem(LS_PROJECT)); if (p && Array.isArray(p.files) && Array.isArray(p.folders)) return p; } catch (e) {}
  return { folders: [], files: [] };
}
function loadSnippets() {
  try { const s = JSON.parse(localStorage.getItem(LS_SNIPPETS)); if (Array.isArray(s)) return s; } catch (e) {}
  return [];
}
function persistProject() { localStorage.setItem(LS_PROJECT, JSON.stringify(project)); }
function persistSnippets() { localStorage.setItem(LS_SNIPPETS, JSON.stringify(snippets)); }
function persistTheme(t) { localStorage.setItem(LS_THEME, t); }

function buildDoc(tab) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${tab.css || ""}</style></head><body>${tab.html || ""}
<script>
const __send=(level,args)=>parent.postMessage({__console:true,level,message:args.map(a=>{try{return typeof a==='object'?JSON.stringify(a):String(a)}catch(e){return String(a)}}).join(' ')},'*');
['log','info','warn','error','debug'].forEach(l=>{const o=console[l];console[l]=(...a)=>{__send(l,a);try{o.apply(console,a)}catch(e){}}});
window.addEventListener('error',e=>__send('error',[e.message+' (line '+e.lineno+')']));
window.addEventListener('unhandledrejection',e=>__send('error',['Unhandled rejection: '+((e.reason&&e.reason.message)||e.reason)]));
<\/script>
<script>${tab.js || ""}<\/script>
</body></html>`;
}

const activeTab = () => tabs.find((t) => t.id === activeId) || tabs[0];

window.addEventListener("message", (e) => {
  if (e.data && e.data.__console) { logs.push({ level: e.data.level, message: e.data.message, time: new Date().toLocaleTimeString() }); renderConsole(); }
});

// ===== Minimap =====
function updateMinimap() { minimapPre.textContent = editor.value || ""; syncMinimap(); }
function syncMinimap() {
  const maxScroll = editor.scrollHeight - editor.clientHeight;
  const frac = maxScroll > 0 ? editor.scrollTop / maxScroll : 0;
  const maxPre = Math.max(0, minimapPre.scrollHeight - minimap.clientHeight);
  minimapPre.style.transform = `translateY(${-frac * maxPre}px)`;
  const indH = (editor.clientHeight / editor.scrollHeight) * minimap.clientHeight;
  minimapVp.style.top = (frac * (minimap.clientHeight - indH)) + "px";
  minimapVp.style.height = indH + "px";
  minimapVp.style.display = editor.scrollHeight > editor.clientHeight ? "block" : "none";
}
function minimapJump(clientY) {
  const rect = minimap.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  editor.scrollTop = ratio * (editor.scrollHeight - editor.clientHeight);
}
minimap.addEventListener("mousedown", (e) => {
  minimapJump(e.clientY);
  const move = (ev) => minimapJump(ev.clientY);
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
});
editor.addEventListener("scroll", syncMinimap);
window.addEventListener("resize", syncMinimap);

// ===== Gutter + folding =====
function renderGutter() {
  const t = activeTab(); const lang = t ? t.editorTab : "html";
  const lines = (editor.value || "").split("\n");
  gutter.innerHTML = "";
  lines.forEach((l, i) => {
    const row = document.createElement("div"); row.className = "he-gutter-row";
    const fold = document.createElement("span"); fold.className = "he-gutter-fold";
    const num = document.createElement("span"); num.className = "he-gutter-num"; num.textContent = i + 1;
    const marker = isFoldMarker(l);
    const start = !marker && isFoldStart(lines, i, lang);
    fold.textContent = marker ? "▸" : (start ? "▾" : "");
    if (marker) fold.addEventListener("click", () => doUnfold(i));
    else if (start) fold.addEventListener("click", () => doFold(i));
    row.appendChild(fold); row.appendChild(num); gutter.appendChild(row);
  });
}
function syncGutter() { gutter.scrollTop = editor.scrollTop; }
editor.addEventListener("scroll", syncGutter);
function doFold(lineIndex) {
  const t = activeTab(); if (!t) return; const lang = t.editorTab;
  const lines = (t[lang] || "").split("\n");
  const end = findBlockEnd(lines, lineIndex, lang);
  if (end <= lineIndex) return;
  const id = "f" + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  const { content, stored } = applyFold(t[lang], lineIndex, end, lang, id);
  t[lang] = content; t.folds = t.folds || []; t.folds.push({ id, stored });
  if (t.id === activeId) { editor.value = t[lang]; renderGutter(); updateMinimap(); }
  schedulePreview();
}
function doUnfold(lineIndex) {
  const t = activeTab(); if (!t) return; const lang = t.editorTab;
  const lines = (t[lang] || "").split("\n");
  const id = parseFoldMarker(lines[lineIndex]); if (!id) return;
  const fold = (t.folds || []).find((f) => f.id === id); if (!fold) return;
  t[lang] = unfoldAt(t[lang], id, fold.stored);
  t.folds = (t.folds || []).filter((f) => f.id !== id);
  if (t.id === activeId) { editor.value = t[lang]; renderGutter(); updateMinimap(); }
  schedulePreview();
}

// ===== Panel drag-to-rearrange =====
let draggedPanel = null;
function initPanelDnD() {
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    const grip = panel.querySelector(".he-grip");
    grip.setAttribute("draggable", "true");
    grip.addEventListener("dragstart", (e) => { draggedPanel = panel; panel.classList.add("he-dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "panel"); });
    panel.addEventListener("dragover", (e) => { e.preventDefault(); if (!draggedPanel || draggedPanel === panel) return; const rect = panel.getBoundingClientRect(); if (e.clientX - rect.left > rect.width / 2) panel.after(draggedPanel); else panel.before(draggedPanel); });
    grip.addEventListener("dragend", () => { if (draggedPanel) draggedPanel.classList.remove("he-dragging"); draggedPanel = null; });
  });
}

// ===== Window controls (minimize / maximize) =====
function maximizePanel(panel) {
  document.querySelectorAll(".he-maximized").forEach((p) => p.classList.remove("he-maximized"));
  panel.classList.add("he-maximized"); panel.classList.remove("he-collapsed");
  $("main").classList.add("he-maximizing");
}
function clearMaximize() {
  document.querySelectorAll(".he-maximized").forEach((p) => p.classList.remove("he-maximized"));
  $("main").classList.remove("he-maximizing");
}
function updateWinLabels() {
  document.querySelectorAll("[data-panel]").forEach((p) => {
    const min = p.querySelector('[data-win=min]'), max = p.querySelector('[data-win=max]');
    if (min) min.textContent = p.classList.contains("he-minimized") ? "＋" : "–";
    if (max) { max.textContent = p.classList.contains("he-maximized") ? "▣" : "▢"; max.classList.toggle("on", p.classList.contains("he-maximized")); }
  });
}
function renderTaskbar() {
  const bar = $("taskbar"); bar.innerHTML = "";
  const mins = document.querySelectorAll("[data-panel].he-minimized");
  if (!mins.length) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  const label = document.createElement("span"); label.className = "he-taskbar-label"; label.textContent = "Minimized"; bar.appendChild(label);
  mins.forEach((p) => {
    const pid = p.dataset.panel;
    const icon = pid === "explorer" ? "📁" : pid === "editor" ? "✏️" : "👁";
    const name = pid === "explorer" ? (explorerView === "library" ? "Library" : "Explorer") : pid === "editor" ? "Editor" : "Preview";
    const btn = document.createElement("button"); btn.className = "he-taskbar-btn"; btn.title = "Restore";
    btn.innerHTML = `<span>${icon}</span><span></span>`; btn.querySelector("span:last-child").textContent = name;
    btn.addEventListener("click", () => { p.classList.remove("he-minimized"); updateWinLabels(); renderTaskbar(); syncMinimap(); });
    bar.appendChild(btn);
  });
}
function initWinControls() {
  document.querySelectorAll("[data-win]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = btn.closest("[data-panel]");
      if (btn.dataset.win === "min") {
        if (panel.classList.contains("he-maximized")) { clearMaximize(); }
        else { panel.classList.toggle("he-minimized"); }
      } else {
        if (panel.classList.contains("he-maximized")) clearMaximize();
        else maximizePanel(panel);
      }
      updateWinLabels(); renderTaskbar(); syncMinimap();
    });
  });
}

// ===== Snippets library =====
function renderExplorer() {
  explorerBody.innerHTML = "";
  if (explorerView === "library") { renderLibrary(); return; }
  if (project.folders.length === 0 && project.files.length === 0) { explorerBody.innerHTML = '<div style="color:var(--muted);font-size:.8rem;padding:.5rem">No saved files yet. Use 💾 Save to add files here.</div>'; return; }
  renderTree(null, 0, explorerBody);
}
function renderLibrary() {
  explorerBody.innerHTML = "";
  if (!snippets.length) { explorerBody.innerHTML = '<div style="color:var(--muted);font-size:.8rem;padding:.5rem">No snippets yet. Click 📚＋ to save reusable code.</div>'; return; }
  snippets.forEach((s) => {
    const item = document.createElement("div"); item.className = "he-lib-item";
    const name = document.createElement("span"); name.className = "he-lib-name"; name.textContent = s.name; name.title = "Insert into current file"; name.addEventListener("click", () => insertSnippet(s));
    const lang = document.createElement("span"); lang.className = "he-lib-lang"; lang.textContent = s.lang;
    const acts = document.createElement("span"); acts.className = "he-exp-actions";
    const ins = document.createElement("button"); ins.className = "he-exp-btn"; ins.title = "Insert"; ins.textContent = "↧"; ins.addEventListener("click", () => insertSnippet(s));
    const ed = document.createElement("button"); ed.className = "he-exp-btn"; ed.title = "Edit"; ed.textContent = "✎"; ed.addEventListener("click", () => editSnippet(s));
    const del = document.createElement("button"); del.className = "he-exp-btn"; del.title = "Delete"; del.textContent = "🗑"; del.addEventListener("click", () => deleteSnippet(s.id));
    acts.appendChild(ins); acts.appendChild(ed); acts.appendChild(del);
    item.appendChild(name); item.appendChild(lang); item.appendChild(acts);
    explorerBody.appendChild(item);
  });
}
function insertSnippet(s) {
  const t = activeTab(); if (!t) return;
  const cur = t[s.lang] || ""; let nc;
  if (t.editorTab === s.lang) { const p = editor.selectionStart, e = editor.selectionEnd; nc = cur.slice(0, p) + s.code + cur.slice(e); }
  else { nc = cur + (cur && !cur.endsWith("\n") ? "\n" : "") + s.code; }
  t[s.lang] = nc; t.editorTab = s.lang;
  if (t.id === activeId) { editor.value = t[s.lang]; renderEditorHead(); renderGutter(); updateMinimap(); }
  schedulePreview();
}
function editSnippet(s) {
  snippetEditId = s.id; $("snippetModalHead").textContent = "Edit Snippet";
  $("snipName").value = s.name; $("snipLang").value = s.lang; $("snipCode").value = s.code;
  $("snippetModal").style.display = "grid";
}
function deleteSnippet(id) { snippets = snippets.filter((s) => s.id !== id); persistSnippets(); renderLibrary(); }
function openNewSnippet() {
  snippetEditId = null; $("snippetModalHead").textContent = "New Snippet";
  const t = activeTab(); let code = "";
  if (t) { const s = editor.selectionStart, e = editor.selectionEnd; if (e > s) code = (t[t.editorTab] || "").slice(s, e); }
  $("snipName").value = ""; $("snipLang").value = t ? t.editorTab : "html"; $("snipCode").value = code;
  $("snippetModal").style.display = "grid";
}
function saveSnippetFromModal() {
  const name = $("snipName").value.trim(); if (!name) { window.alert("Snippet name required"); return; }
  const lang = $("snipLang").value, code = $("snipCode").value;
  if (snippetEditId) snippets = snippets.map((s) => (s.id === snippetEditId ? { ...s, name, lang, code } : s));
  else snippets.push({ id: "snip_" + Date.now(), name, lang, code });
  persistSnippets(); $("snippetModal").style.display = "none"; renderLibrary();
}

// ===== Search & replace =====
function buildRegex(q, o) {
  if (!q) return null;
  let src = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.word) src = "\\b" + src + "\\b";
  let flags = "g"; if (!o.case) flags += "i";
  try { return new RegExp(src, flags); } catch { return null; }
}
function openSearch(withReplace) { searchOpen = true; searchBar.style.display = "flex"; searchInput.focus(); if (withReplace) setReplaceOpen(true); }
function closeSearch() { searchOpen = false; searchBar.style.display = "none"; }
function setReplaceOpen(v) {
  replaceOpen = v;
  replaceInput.style.display = v ? "block" : "none";
  $("replaceBtn").style.display = v ? "inline-flex" : "none";
  $("replaceAllBtn").style.display = v ? "inline-flex" : "none";
  $("toggleReplaceBtn").textContent = (v ? "▾" : "▸") + " Replace";
}
function scheduleSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); }
function runSearch() {
  const results = [];
  if (searchQ) {
    const re = buildRegex(searchQ, searchOpts);
    if (re) for (const tab of tabs) for (const lang of ["html", "css", "js"]) {
      const c = tab[lang] || ""; re.lastIndex = 0; let m;
      while ((m = re.exec(c)) && results.length < 500) {
        const before = c.slice(0, m.index); const line = before.split("\n").length;
        results.push({ tabId: tab.id, tabName: tab.name, lang, offset: m.index, length: m[0].length, line, preview: c.slice(m.index, m.index + 80).replace(/\n/g, " ") });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  searchResults = results; searchIdx = 0; renderSearchResults();
}
function renderSearchResults() {
  searchCountEl.textContent = searchResults.length + " matches";
  searchResultsEl.innerHTML = "";
  searchResults.forEach((r, i) => {
    const row = document.createElement("div"); row.className = "he-search-res" + (i === searchIdx ? " active" : "");
    const loc = document.createElement("span"); loc.className = "he-res-loc"; loc.textContent = `${r.tabName}:${r.lang}:${r.line}`;
    const prev = document.createElement("span"); prev.style.overflow = "hidden"; prev.style.textOverflow = "ellipsis"; prev.textContent = r.preview;
    row.appendChild(loc); row.appendChild(prev);
    row.addEventListener("click", () => { searchIdx = i; renderSearchResults(); gotoResult(r); });
    searchResultsEl.appendChild(row);
  });
}
function gotoResult(r) {
  activeId = r.tabId; const t = activeTab(); if (!t) return; t.editorTab = r.lang; syncActive();
  editor.focus(); editor.selectionStart = r.offset; editor.selectionEnd = r.offset + r.length;
  const before = editor.value.slice(0, r.offset); const line = before.split("\n").length;
  const lh = parseFloat(getComputedStyle(editor).lineHeight) || 22;
  editor.scrollTop = Math.max(0, (line - 5) * lh);
  renderGutter(); updateMinimap();
}
function searchStep(d) { if (!searchResults.length) return; searchIdx = (searchIdx + d + searchResults.length) % searchResults.length; renderSearchResults(); gotoResult(searchResults[searchIdx]); }
function replaceCurrent() {
  const r = searchResults[searchIdx]; if (!r) return; const t = tabs.find((x) => x.id === r.tabId); if (!t) return;
  const c = t[r.lang]; t[r.lang] = c.slice(0, r.offset) + replaceQ + c.slice(r.offset + r.length);
  if (t.id === activeId && t.editorTab === r.lang) { editor.value = t[r.lang]; renderGutter(); updateMinimap(); schedulePreview(); }
  scheduleSearch();
}
function replaceAll() {
  const re = buildRegex(searchQ, searchOpts); if (!re) return;
  tabs.forEach((t) => ["html", "css", "js"].forEach((l) => { t[l] = (t[l] || "").replace(re, replaceQ); }));
  syncActive(); scheduleSearch();
}
$("searchBtn").addEventListener("click", () => openSearch(false));
$("findInEditorBtn").addEventListener("click", () => openSearch(false));
$("closeSearchBtn").addEventListener("click", closeSearch);
$("toggleReplaceBtn").addEventListener("click", () => setReplaceOpen(!replaceOpen));
searchInput.addEventListener("input", () => { searchQ = searchInput.value; scheduleSearch(); });
replaceInput.addEventListener("input", () => { replaceQ = replaceInput.value; });
$("searchPrev").addEventListener("click", () => searchStep(-1));
$("searchNext").addEventListener("click", () => searchStep(1));
$("replaceBtn").addEventListener("click", replaceCurrent);
$("replaceAllBtn").addEventListener("click", replaceAll);
$("optCase").addEventListener("click", () => { searchOpts.case = !searchOpts.case; $("optCase").classList.toggle("on", searchOpts.case); scheduleSearch(); });
$("optWord").addEventListener("click", () => { searchOpts.word = !searchOpts.word; $("optWord").classList.toggle("on", searchOpts.word); scheduleSearch(); });
$("optRegex").addEventListener("click", () => { searchOpts.regex = !searchOpts.regex; $("optRegex").classList.toggle("on", searchOpts.regex); scheduleSearch(); });
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "f") { e.preventDefault(); openSearch(false); }
  else if ((e.ctrlKey || e.metaKey) && k === "h") { e.preventDefault(); openSearch(true); }
  else if (e.key === "Escape" && searchOpen) closeSearch();
});

// ===== Rendering =====
function renderTabs() {
  tabbar.innerHTML = "";
  [...tabs].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1)).forEach((t) => {
    const el = document.createElement("div");
    el.className = "he-tab" + (t.id === activeId ? " active" : "") + (t.pinned ? " pinned" : "");
    el.title = t.name;
    el.innerHTML = `<span class="he-tab-pin-dot"></span><span class="he-tab-name"></span>` + (t.pinned ? "" : `<button class="he-tab-close">×</button>`);
    el.querySelector(".he-tab-name").textContent = t.name;
    el.addEventListener("click", () => { activeId = t.id; syncActive(); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); openCtx(e.clientX, e.clientY, [
      { label: "✏️ Rename", fn: () => renameTab(t.id) },
      { label: t.pinned ? "📌 Unpin" : "📌 Pin", fn: () => { t.pinned = !t.pinned; renderTabs(); } },
      { sep: true },
      { label: "✕ Close", fn: () => closeTab(t.id) }
    ]); });
    const close = el.querySelector(".he-tab-close"); if (close) close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
    tabbar.appendChild(el);
  });
  const plus = document.createElement("button"); plus.className = "he-newtab"; plus.title = "New tab"; plus.textContent = "+"; plus.addEventListener("click", addBlankTab); tabbar.appendChild(plus);
}
function syncActive() {
  renderTabs(); renderEditorHead();
  const t = activeTab();
  if (t) { editor.value = t[t.editorTab] || ""; activeNameEl.textContent = t.name; }
  else { editor.value = ""; activeNameEl.textContent = ""; }
  renderGutter(); updateMinimap(); scheduleSearch(); schedulePreview();
}
function renderEditorHead() {
  const t = activeTab();
  editorHead.querySelectorAll(".he-seg").forEach((b) => b.classList.toggle("active", t && t.editorTab === b.dataset.lang));
}
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(() => { const t = activeTab(); if (t) preview.srcdoc = buildDoc(t); }, 400); }
function renderConsole() {
  if (!logs.length) { consoleBody.innerHTML = '<div style="color:var(--muted)">Console output from your JavaScript will appear here.</div>'; return; }
  consoleBody.innerHTML = logs.map((l) => `<div class="he-log ${l.level}"><span class="he-log-time">${l.time}</span><span class="he-log-msg"></span></div>`).join("");
  Array.from(consoleBody.querySelectorAll(".he-log")).forEach((el, i) => { el.querySelector(".he-log-msg").textContent = logs[i].message; });
}
function renderTemplatesMenu() {
  const groups = {}; templates.forEach((t, i) => { (groups[t.category] = groups[t.category] || []).push({ ...t, _i: i }); });
  tplMenu.innerHTML = "";
  Object.entries(groups).forEach(([cat, items]) => {
    const catEl = document.createElement("div"); catEl.className = "he-menu-cat"; catEl.textContent = cat; tplMenu.appendChild(catEl);
    items.forEach((t) => {
      const it = document.createElement("div"); it.className = "he-menu-item";
      it.innerHTML = `<span class="he-tpl-icon">${t.icon}</span><span></span>`;
      it.querySelector("span:last-child").textContent = t.name;
      it.addEventListener("click", () => addTemplate(t)); tplMenu.appendChild(it);
    });
  });
}
function renderTree(parentId, depth, container) {
  project.folders.filter((f) => (f.parentId || null) === parentId).forEach((f) => {
    const row = document.createElement("div");
    const item = document.createElement("div");
    item.className = "he-exp-item"; item.style.paddingLeft = (depth * 14 + 4) + "px";
    item.innerHTML = `<span class="he-exp-chevron"></span><span></span><span class="he-exp-actions"><button class="he-exp-btn" title="New file">＋</button></span>`;
    item.querySelector(".he-exp-chevron").textContent = expanded[f.id] ? "▾" : "▸";
    item.querySelector("span:nth-of-type(2)").textContent = "📁 " + f.name;
    item.querySelector(".he-exp-chevron").addEventListener("click", (e) => { e.stopPropagation(); toggleExpand(f.id); });
    item.querySelector("span:nth-of-type(2)").addEventListener("click", () => toggleExpand(f.id));
    item.querySelector(".he-exp-btn").addEventListener("click", (e) => { e.stopPropagation(); createFile(f.id); });
    item.addEventListener("contextmenu", (e) => { e.preventDefault(); openCtx(e.clientX, e.clientY, [
      { label: "📄 New file", fn: () => createFile(f.id) },
      { label: "📁 New folder", fn: () => createFolder(f.id) },
      { label: "✎ Rename", fn: () => renameItem(f, true) },
      { sep: true },
      { label: "🗑 Delete", fn: () => deleteFolder(f.id) }
    ]); });
    row.appendChild(item);
    if (expanded[f.id]) { const sub = document.createElement("div"); renderTree(f.id, depth + 1, sub); row.appendChild(sub); }
    container.appendChild(row);
  });
  project.files.filter((f) => (f.folderId || null) === parentId).forEach((f) => {
    const item = document.createElement("div");
    item.className = "he-exp-item"; item.style.paddingLeft = (depth * 14 + 18) + "px";
    item.innerHTML = `<span></span><span class="he-exp-actions"><button class="he-exp-btn" title="Rename">✎</button><button class="he-exp-btn" title="Delete">🗑</button></span>`;
    item.querySelector("span:first-child").textContent = "📄 " + f.name;
    item.addEventListener("click", () => openExplorerFile(f));
    item.querySelector("button[title=Rename]").addEventListener("click", (e) => { e.stopPropagation(); renameItem(f, false); });
    item.querySelector("button[title=Delete]").addEventListener("click", (e) => { e.stopPropagation(); deleteFile(f.id); });
    item.addEventListener("contextmenu", (e) => { e.preventDefault(); openCtx(e.clientX, e.clientY, [
      { label: "📂 Open", fn: () => openExplorerFile(f) },
      { label: "✎ Rename", fn: () => renameItem(f, false) },
      { sep: true },
      { label: "🗑 Delete", fn: () => deleteFile(f.id) }
    ]); });
    container.appendChild(item);
  });
}
function openCtx(x, y, items) {
  ctxMenu.innerHTML = "";
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement("div"); s.className = "he-ctx-sep"; ctxMenu.appendChild(s); return; }
    const el = document.createElement("div"); el.className = "he-ctx-item"; el.textContent = it.label;
    el.addEventListener("click", () => { it.fn(); hideCtx(); });
    ctxMenu.appendChild(el);
  });
  ctxMenu.style.left = x + "px"; ctxMenu.style.top = y + "px"; ctxMenu.style.display = "block";
}
function hideCtx() { ctxMenu.style.display = "none"; }
window.addEventListener("click", hideCtx);
window.addEventListener("scroll", hideCtx, true);

// ===== Actions =====
function addBlankTab() { const t = makeTab(); tabs.push(t); activeId = t.id; syncActive(); }
function addTemplate(tpl) { const t = makeTab(tpl.name + (tpl.category === "HTML" ? ".html" : ""), tpl.data); tabs.push(t); activeId = t.id; syncActive(); tplMenu.style.display = "none"; }
function openFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || ""); const ext = file.name.split(".").pop().toLowerCase();
    const data = { html: "", css: "", js: "" };
    if (ext === "css") data.css = text; else if (ext === "js") data.js = text; else data.html = text;
    const t = makeTab(file.name, data); tabs.push(t); activeId = t.id; syncActive();
  };
  reader.readAsText(file);
}
function onFilesPicked(files) { Array.from(files).forEach(openFile); }
function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id); if (idx === -1) return;
  tabs = tabs.filter((t) => t.id !== id);
  if (activeId === id) { const fb = tabs[idx] || tabs[idx - 1] || tabs[0]; activeId = fb ? fb.id : null; if (!fb) { logs = []; renderConsole(); } }
  syncActive();
}
function renameTab(id) { const t = tabs.find((x) => x.id === id); const name = window.prompt("Tab name:", t ? t.name : ""); if (name && name.trim()) { t.name = name.trim(); syncActive(); } }
function formatCurrent() { const t = activeTab(); if (!t) return; const field = t.editorTab; t[field] = field === "html" ? formatHTML(t[field] || "") : field === "css" ? formatCSS(t[field] || "") : formatJS(t[field] || ""); t.folds = []; editor.value = t[field]; renderGutter(); updateMinimap(); }
function openInNewTab() { const t = activeTab(); if (!t) return; const w = window.open("about:blank", "_blank"); if (w) { w.document.open(); w.document.write(buildDoc(t)); w.document.close(); } }
function refreshPreview() { const t = activeTab(); if (t) preview.srcdoc = buildDoc(t); }
function saveCurrent() {
  const t = activeTab(); if (!t) return;
  if (t.fileId) { const f = project.files.find((x) => x.id === t.fileId); if (f) { f.name = t.name; f.html = t.html; f.css = t.css; f.js = t.js; } }
  else { const name = window.prompt("Save file as:", t.name); if (!name || !name.trim()) return; const id = "file_" + Date.now(); project.files.push({ id, name: name.trim(), folderId: null, html: t.html, css: t.css, js: t.js }); t.fileId = id; t.name = name.trim(); }
  persistProject(); renderExplorer(); renderTabs();
}
function openExplorerFile(file) { const existing = tabs.find((t) => t.fileId === file.id); if (existing) { activeId = existing.id; syncActive(); return; } const t = makeTab(file.name, { html: file.html, css: file.css, js: file.js }, file.id); tabs.push(t); activeId = t.id; syncActive(); }
function createFolder(parentId) { const name = window.prompt("Folder name:", "New Folder"); if (!name || !name.trim()) return; project.folders.push({ id: "fld_" + Date.now(), name: name.trim(), parentId }); persistProject(); renderExplorer(); }
function createFile(folderId) { const name = window.prompt("File name:", "page.html"); if (!name || !name.trim()) return; const id = "file_" + Date.now(); project.files.push({ id, name: name.trim(), folderId, html: "", css: "", js: "" }); persistProject(); renderExplorer(); const t = makeTab(name.trim(), { html: "", css: "", js: "" }, id); tabs.push(t); activeId = t.id; syncActive(); }
function renameItem(item, isFolder) { const name = window.prompt(isFolder ? "Folder name:" : "File name:", item.name); if (!name || !name.trim()) return; item.name = name.trim(); persistProject(); renderExplorer(); renderTabs(); }
function deleteFolder(id) {
  if (!window.confirm("Delete folder and all its contents?")) return;
  const toRemove = new Set([id]); let changed = true;
  while (changed) changed = project.folders.some((f) => f.parentId && toRemove.has(f.parentId) && !toRemove.has(f.id) && toRemove.add(f.id));
  project.folders = project.folders.filter((f) => !toRemove.has(f.id));
  project.files = project.files.filter((f) => !toRemove.has(f.folderId));
  persistProject(); renderExplorer();
}
function deleteFile(id) {
  if (!window.confirm("Delete this file?")) return;
  project.files = project.files.filter((f) => f.id !== id);
  tabs = tabs.filter((t) => t.fileId !== id);
  if (!tabs.find((t) => t.id === activeId)) activeId = tabs.length ? tabs[tabs.length - 1].id : null;
  persistProject(); renderExplorer(); syncActive();
}
function toggleExpand(id) { expanded[id] = !expanded[id]; renderExplorer(); }

// ===== Wiring =====
$("tplBtn").addEventListener("click", (e) => { e.stopPropagation(); tplMenu.style.display = tplMenu.style.display === "none" ? "block" : "none"; });
$("openBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (e) => { onFilesPicked(e.target.files); e.target.value = ""; });
$("newBtn").addEventListener("click", addBlankTab);
$("fmtBtn").addEventListener("click", formatCurrent);
$("saveBtn").addEventListener("click", saveCurrent);
$("runBtn").addEventListener("click", refreshPreview);
$("newTabBtn").addEventListener("click", openInNewTab);
$("refreshBtn").addEventListener("click", refreshPreview);
$("openNewBtn").addEventListener("click", openInNewTab);
$("newFileBtn").addEventListener("click", () => createFile(null));
$("newFolderBtn").addEventListener("click", () => createFolder(null));
$("newSnippetBtn").addEventListener("click", openNewSnippet);
$("snipSave").addEventListener("click", saveSnippetFromModal);
$("snipCancel").addEventListener("click", () => { $("snippetModal").style.display = "none"; });
document.querySelectorAll(".he-view-tab").forEach((b) => b.addEventListener("click", () => {
  explorerView = b.dataset.view;
  document.querySelectorAll(".he-view-tab").forEach((x) => x.classList.toggle("active", x === b));
  $("newFileBtn").style.display = explorerView === "project" ? "inline-flex" : "none";
  $("newFolderBtn").style.display = explorerView === "project" ? "inline-flex" : "none";
  $("newSnippetBtn").style.display = explorerView === "library" ? "inline-flex" : "none";
  renderExplorer();
}));
$("clrBtn").addEventListener("click", () => { logs = []; renderConsole(); });
$("hideConsole").addEventListener("click", () => { consoleEl.style.display = "none"; });

editorHead.querySelectorAll(".he-seg").forEach((b) => b.addEventListener("click", () => { const t = activeTab(); if (!t) return; t.editorTab = b.dataset.lang; editor.value = t[t.editorTab] || ""; renderEditorHead(); renderGutter(); updateMinimap(); }));
editor.addEventListener("input", () => { const t = activeTab(); if (!t) return; t[t.editorTab] = editor.value; renderGutter(); updateMinimap(); scheduleSearch(); schedulePreview(); });
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault(); const s = editor.selectionStart, en = editor.selectionEnd, val = editor.value; const t = activeTab(); if (!t) return;
    t[t.editorTab] = val.slice(0, s) + "  " + val.slice(en); editor.value = t[t.editorTab]; renderGutter(); updateMinimap();
    requestAnimationFrame(() => { editor.selectionStart = editor.selectionEnd = s + 2; });
  }
});

editorWrap.addEventListener("dragover", (e) => { e.preventDefault(); dropOverlay.style.display = "grid"; });
editorWrap.addEventListener("dragleave", (e) => { if (e.target === editorWrap) dropOverlay.style.display = "none"; });
editorWrap.addEventListener("drop", (e) => { e.preventDefault(); dropOverlay.style.display = "none"; if (e.dataTransfer.files.length) onFilesPicked(e.dataTransfer.files); });

const themeSelect = $("themeSelect");
themeSelect.addEventListener("change", (e) => { root.setAttribute("data-theme", e.target.value); persistTheme(e.target.value); });

// ===== Init =====
const savedTheme = localStorage.getItem(LS_THEME) || "black";
root.setAttribute("data-theme", savedTheme); themeSelect.value = savedTheme;
const first = makeTab("index.html", templates[0].data);
tabs = [first]; activeId = first.id;
renderTemplatesMenu(); renderExplorer(); renderConsole();
initPanelDnD(); initWinControls();
syncActive();
