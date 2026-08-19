import { templates } from "./templates.js";
import { formatHTML, formatCSS, formatJS } from "./formatter.js";

const LS_PROJECT = "htmlStudio.project.v1";
const LS_THEME = "htmlStudio.theme";

let _id = 1;
const makeTab = (name = "Untitled.html", data = { html: "", css: "", js: "" }, fileId = null) => ({
  id: _id++, name, html: data.html || "", css: data.css || "", js: data.js || "",
  pinned: false, editorTab: "html", fileId
});

let tabs = [];
let activeId = null;
let logs = [];
let previewTimer = null;
let project = loadProject();
let expanded = {};

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

function loadProject() {
  try { const p = JSON.parse(localStorage.getItem(LS_PROJECT)); if (p && Array.isArray(p.files) && Array.isArray(p.folders)) return p; } catch (e) {}
  return { folders: [], files: [] };
}
function persistProject() { localStorage.setItem(LS_PROJECT, JSON.stringify(project)); }
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

// ===== Panel drag-to-rearrange (native HTML5 DnD) =====
let draggedPanel = null;
function initPanelDnD() {
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    const grip = panel.querySelector(".he-grip");
    grip.setAttribute("draggable", "true");
    grip.addEventListener("dragstart", (e) => {
      draggedPanel = panel; panel.classList.add("he-dragging");
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "panel");
    });
    panel.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!draggedPanel || draggedPanel === panel) return;
      const rect = panel.getBoundingClientRect();
      const after = e.clientX - rect.left > rect.width / 2;
      if (after) panel.after(draggedPanel); else panel.before(draggedPanel);
    });
    grip.addEventListener("dragend", () => { if (draggedPanel) draggedPanel.classList.remove("he-dragging"); draggedPanel = null; });
  });
}

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
    const close = el.querySelector(".he-tab-close");
    if (close) close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
    tabbar.appendChild(el);
  });
  const plus = document.createElement("button");
  plus.className = "he-newtab"; plus.title = "New tab"; plus.textContent = "+";
  plus.addEventListener("click", addBlankTab);
  tabbar.appendChild(plus);
}

function syncActive() {
  renderTabs();
  renderEditorHead();
  const t = activeTab();
  if (t) { editor.value = t[t.editorTab] || ""; activeNameEl.textContent = t.name; }
  else { editor.value = ""; activeNameEl.textContent = ""; }
  updateMinimap();
  schedulePreview();
}

function renderEditorHead() {
  const t = activeTab();
  editorHead.querySelectorAll(".he-seg").forEach((b) => b.classList.toggle("active", t && t.editorTab === b.dataset.lang));
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { const t = activeTab(); if (t) preview.srcdoc = buildDoc(t); }, 400);
}

function renderConsole() {
  if (!logs.length) { consoleBody.innerHTML = '<div style="color:var(--muted)">Console output from your JavaScript will appear here.</div>'; return; }
  consoleBody.innerHTML = logs.map((l) => `<div class="he-log ${l.level}"><span class="he-log-time">${l.time}</span><span class="he-log-msg"></span></div>`).join("");
  Array.from(consoleBody.querySelectorAll(".he-log")).forEach((el, i) => { el.querySelector(".he-log-msg").textContent = logs[i].message; });
}

function renderTemplatesMenu() {
  const groups = {};
  templates.forEach((t, i) => { (groups[t.category] = groups[t.category] || []).push({ ...t, _i: i }); });
  tplMenu.innerHTML = "";
  Object.entries(groups).forEach(([cat, items]) => {
    const catEl = document.createElement("div"); catEl.className = "he-menu-cat"; catEl.textContent = cat; tplMenu.appendChild(catEl);
    items.forEach((t) => {
      const it = document.createElement("div"); it.className = "he-menu-item";
      it.innerHTML = `<span class="he-tpl-icon">${t.icon}</span><span></span>`;
      it.querySelector("span:last-child").textContent = t.name;
      it.addEventListener("click", () => addTemplate(t));
      tplMenu.appendChild(it);
    });
  });
}

function renderExplorer() {
  explorerBody.innerHTML = "";
  if (project.folders.length === 0 && project.files.length === 0) {
    explorerBody.innerHTML = '<div style="color:var(--muted);font-size:.8rem;padding:.5rem">No saved files yet. Use 💾 Save to add files here.</div>';
    return;
  }
  renderTree(null, 0, explorerBody);
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
function updateActive(patch) { const t = activeTab(); if (!t) return; Object.assign(t, patch); renderTabs(); }
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
function formatCurrent() { const t = activeTab(); if (!t) return; const field = t.editorTab; t[field] = field === "html" ? formatHTML(t[field] || "") : field === "css" ? formatCSS(t[field] || "") : formatJS(t[field] || ""); editor.value = t[field]; updateMinimap(); renderTabs(); }
function openInNewTab() { const t = activeTab(); if (!t) return; const w = window.open("about:blank", "_blank"); if (w) { w.document.open(); w.document.write(buildDoc(t)); w.document.close(); } }
function refreshPreview() { const t = activeTab(); if (t) preview.srcdoc = buildDoc(t); }

function saveCurrent() {
  const t = activeTab(); if (!t) return;
  if (t.fileId) { const f = project.files.find((x) => x.id === t.fileId); if (f) { f.name = t.name; f.html = t.html; f.css = t.css; f.js = t.js; } }
  else { const name = window.prompt("Save file as:", t.name); if (!name || !name.trim()) return; const id = "file_" + Date.now(); project.files.push({ id, name: name.trim(), folderId: null, html: t.html, css: t.css, js: t.js }); t.fileId = id; t.name = name.trim(); }
  persistProject(); renderExplorer(); renderTabs();
}
function openExplorerFile(file) {
  const existing = tabs.find((t) => t.fileId === file.id); if (existing) { activeId = existing.id; syncActive(); return; }
  const t = makeTab(file.name, { html: file.html, css: file.css, js: file.js }, file.id); tabs.push(t); activeId = t.id; syncActive();
}
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
$("clrBtn").addEventListener("click", () => { logs = []; renderConsole(); });
$("hideConsole").addEventListener("click", () => { consoleEl.style.display = "none"; });

editorHead.querySelectorAll(".he-seg").forEach((b) => b.addEventListener("click", () => { const t = activeTab(); if (!t) return; t.editorTab = b.dataset.lang; editor.value = t[t.editorTab] || ""; renderEditorHead(); updateMinimap(); }));
editor.addEventListener("input", () => { const t = activeTab(); if (!t) return; t[t.editorTab] = editor.value; updateMinimap(); schedulePreview(); });
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault(); const s = editor.selectionStart, en = editor.selectionEnd, val = editor.value; const t = activeTab(); if (!t) return;
    t[t.editorTab] = val.slice(0, s) + "  " + val.slice(en); editor.value = t[t.editorTab]; updateMinimap();
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
initPanelDnD();
syncActive();
