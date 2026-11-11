// CSV 备份柜 —— 前端逻辑（零依赖，直接用原生 DOM/API）
// 约定：服务端失败一律返回 {ok:false, code, message}，这里只展示 message。

const API = "/api";

const state = {
  view: "files",      // files | trash
  files: [],
  trash: [],
  stats: null,
  limits: { maxFileBytes: 20 * 1024 * 1024, maxTags: 8 },
  query: "",
  tag: "",
  sort: "updated",
  uploads: 0,
};

const $ = (sel) => document.querySelector(sel);

// ---------------- 工具

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + " " + units[i];
}

function relTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60e3) return "刚刚";
  if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前";
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前";
  if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + " 天前";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fullTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function iconFor(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  if (ext === "csv") return "📊";
  if (ext === "tsv") return "📋";
  if (ext === "json" || ext === "ndjson") return "🧾";
  if (ext === "md") return "📝";
  if (ext === "log") return "🪵";
  return "📄";
}

let toastTimer;
function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show " + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.hidden = true; }, 220);
  }, kind === "err" ? 4200 : 2400);
}

// ---------------- 请求

async function api(path, { method = "GET", body, raw = false, skipAuthGate = false } = {}) {
  const init = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;              // 浏览器自己带 boundary
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, init);
  // 401 意味着会话失效；但登录接口本身返回 401 是「密码错」，不能当成会话过期
  if (!skipAuthGate && res.status === 401) {
    showGate();
    throw new Error("登录已失效，请重新登录");
  }
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || (data && data.ok === false)) {
    const err = new Error((data && data.message) || `请求失败（HTTP ${res.status}）`);
    err.code = data && data.code;
    err.missing = (data && data.missing) || [];
    throw err;
  }
  return data;
}

// ---------------- 部署自检

/** 缺绑定 / 缺口令时，直接把「去哪儿点」摆出来，不让人对着 503 猜 */
function showSetup(missing, extra = {}) {
  $("#gate").hidden = true;
  $("#app").hidden = true;
  $("#setup").hidden = false;

  const list = $("#setup-list");
  list.innerHTML = (missing || [])
    .map(
      (m) => `<li class="setup-item">
        <strong>${esc(m.label || m.key)}</strong>
        <span class="setup-key">${esc(m.key)}</span>
        <div class="setup-where">${esc(m.where || "")}</div>
        <div class="setup-hint">${esc(m.hint || "")}</div>
      </li>`
    )
    .join("");

  if (!list.children.length) {
    list.innerHTML = `<li class="setup-item">配置项都齐了，但服务端仍报错：${esc(extra.message || "未知")}</li>`;
  }

  const vars = extra.vars || [];
  $("#setup-msg").textContent = vars.length
    ? `已检测到的环境变量：${vars.join("、")}`
    : "";
}

async function boot() {
  let health;
  try {
    health = await api("/health");
  } catch (err) {
    showSetup([], { message: err.message });
    return;
  }
  if (!health.ready) {
    showSetup(health.missing, health);
    return;
  }
  await checkSession();
}

$("#setup-retry").addEventListener("click", async () => {
  const btn = $("#setup-retry");
  btn.disabled = true;
  btn.textContent = "检测中…";
  try {
    const health = await api("/health");
    if (health.ready) {
      location.reload();
    } else {
      showSetup(health.missing, health);
    }
  } catch (err) {
    $("#setup-msg").textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "重新检测";
  }
});

// ---------------- 登录

function showGate() {
  $("#gate").hidden = false;
  $("#app").hidden = true;
  setTimeout(() => $("#password").focus(), 60);
}

function showApp() {
  $("#gate").hidden = true;
  $("#app").hidden = false;
}

async function checkSession() {
  try {
    const me = await api("/me");
    if (!me.hasPassword) {
      showGate();
      $("#login-msg").textContent = "服务端还没设置 ACCESS_PASSWORD，请在 Cloudflare Pages 里配置环境变量后重新部署。";
      $("#login-btn").disabled = true;
      return;
    }
    if (me.authed) { showApp(); await refreshAll(); }
    else showGate();
  } catch (err) {
    showGate();
    $("#login-msg").textContent = err.message;
  }
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-btn");
  const msg = $("#login-msg");
  const password = $("#password").value;
  if (!password) return;
  btn.disabled = true;
  btn.textContent = "验证中…";
  msg.textContent = "";
  try {
    await api("/login", { method: "POST", body: { password }, skipAuthGate: true });
    $("#password").value = "";
    showApp();
    await refreshAll();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "进入";
  }
});

$("#btn-logout").addEventListener("click", async () => {
  try { await api("/logout", { method: "POST", body: {} }); } catch { /* 无所谓 */ }
  state.files = [];
  state.trash = [];
  showGate();
});

// ---------------- 数据装载

async function refreshAll() {
  await Promise.all([loadStats(), loadFiles(), loadTrash()]);
  render();
}

async function loadStats() {
  try { state.stats = await api("/stats"); } catch { /* 概览失败不影响列表 */ }
}

async function loadFiles() {
  const data = await api("/files");
  state.files = data.files || [];
  if (data.limits) {
    state.limits = data.limits;
    // 提示文案跟着后端真实上限走，改了 config.js 也不会对不上
    const hint = $("#max-size");
    if (hint && state.limits.maxFileBytes) hint.textContent = formatBytes(state.limits.maxFileBytes);
  }
}

async function loadTrash() {
  try {
    const data = await api("/trash");
    state.trash = data.files || [];
  } catch { state.trash = []; }
}

// ---------------- 渲染

function render() {
  renderStats();
  renderTabCounts();
  renderTagbar();
  renderList();
}

function renderStats() {
  const s = state.stats;
  const box = $("#stats");
  if (!s) { box.innerHTML = ""; return; }
  const pct = s.quotaBytes ? Math.min(100, (s.totalBytes / s.quotaBytes) * 100) : 0;
  box.innerHTML = `
    <div class="stat">
      <div class="stat-k">文件</div>
      <div class="stat-v">${s.fileCount}<small>个</small></div>
    </div>
    <div class="stat">
      <div class="stat-k">已占用</div>
      <div class="stat-v">${esc(formatBytes(s.totalBytes))}</div>
    </div>
    <div class="stat quota">
      <div class="stat-k">免费额度（1 GB）</div>
      <div class="stat-v">${pct < 0.1 ? "0" : pct.toFixed(1)}<small>%</small></div>
      <div class="stat-bar${pct > 90 ? " full" : ""}"><i style="width:${Math.max(pct, 0.6)}%"></i></div>
    </div>
    <div class="stat">
      <div class="stat-k">最近更新</div>
      <div class="stat-v" style="font-size:15px">${s.lastUpdated ? esc(relTime(s.lastUpdated)) : "—"}</div>
    </div>`;
}

function renderTabCounts() {
  $("#n-files").textContent = state.files.length;
  $("#n-trash").textContent = state.trash.length;
}

function renderTagbar() {
  const tags = (state.stats && state.stats.tags) || [];
  const bar = $("#tagbar");
  if (!tags.length) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML = tags
    .map((t) => `<button class="tag-chip${state.tag === t.name ? " on" : ""}" data-tag="${esc(t.name)}">${esc(t.name)}<span class="n">${t.count}</span></button>`)
    .join("");
}

function visibleItems() {
  const list = state.view === "trash" ? state.trash : state.files;
  const q = state.query.trim().toLowerCase();
  let out = list;
  if (q) {
    out = out.filter((f) =>
      f.name.toLowerCase().includes(q) ||
      (f.tags || []).some((t) => t.toLowerCase().includes(q)) ||
      (f.preview || "").toLowerCase().includes(q)
    );
  }
  if (state.tag && state.view === "files") {
    out = out.filter((f) => (f.tags || []).includes(state.tag));
  }
  const sorted = out.slice();
  if (state.view === "trash") {
    sorted.sort((a, b) => b.trashedAt - a.trashedAt);
  } else if (state.sort === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  } else if (state.sort === "size") {
    sorted.sort((a, b) => b.size - a.size);
  } else {
    sorted.sort((a, b) => b.updated - a.updated);
  }
  return sorted;
}

function renderList() {
  const wrap = $("#list-wrap");
  const items = visibleItems();

  if (!items.length) {
    wrap.innerHTML = state.view === "trash"
      ? `<div class="empty">
           <div class="empty-icon">🗑️</div>
           <div class="empty-title">回收站是空的</div>
           <div class="empty-hint">删除文件时会先放这里，随时可以还原。</div>
         </div>`
      : `<div class="empty">
           <div class="empty-icon">📥</div>
           <div class="empty-title">${state.query || state.tag ? "没有匹配的文件" : "还没有备份"}</div>
           <div class="empty-hint">${state.query || state.tag ? "换个关键词，或清掉筛选条件。" : "把 CSV 拖到上面的虚线框里就能存进来。"}</div>
         </div>`;
    return;
  }

  wrap.innerHTML = items.map((f) => rowHtml(f)).join("");
  wrap.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", onAction);
  });
}

function rowHtml(f) {
  const slash = f.name.lastIndexOf("/");
  const dir = slash > 0 ? f.name.slice(0, slash + 1) : "";
  const base = slash > 0 ? f.name.slice(slash + 1) : f.name;

  const meta = [];
  meta.push(`<span title="${esc(fullTime(f.updated))}">${esc(relTime(f.updated))}</span>`);
  meta.push(`<span class="dot">${esc(formatBytes(f.size))}</span>`);
  if (f.versionCount > 0) meta.push(`<span class="pill ver">v${f.versionCount + 1}</span>`);
  if (state.view === "trash") meta.push(`<span class="dot">删除于 ${esc(relTime(f.trashedAt))}</span>`);

  const tags = (f.tags || []).length
    ? `<div class="row-tags">${f.tags.map((t) => `<span class="row-tag">${esc(t)}</span>`).join("")}</div>`
    : "";

  const preview = state.view === "files" && f.preview
    ? `<div class="row-preview">${esc(f.preview)}</div>`
    : "";

  const actions = state.view === "trash"
    ? `<button class="icon-btn" data-act="restore" data-id="${esc(f.id)}" title="还原">↩</button>
       <button class="icon-btn danger" data-act="purge" data-id="${esc(f.id)}" title="彻底删除">✕</button>`
    : `<button class="icon-btn" data-act="download" data-id="${esc(f.id)}" title="下载">⤓</button>
       <button class="icon-btn" data-act="versions" data-id="${esc(f.id)}" title="版本历史">◷</button>
       <button class="icon-btn" data-act="edit" data-id="${esc(f.id)}" title="改名 / 标签">✎</button>
       <button class="icon-btn danger" data-act="trash" data-id="${esc(f.id)}" title="移到回收站">🗑</button>`;

  return `<div class="row${state.view === "trash" ? " trashed" : ""}" data-id="${esc(f.id)}">
    <div class="row-icon">${state.view === "trash" ? "🗑" : iconFor(f.name)}</div>
    <div class="row-main">
      <div class="row-name" title="${esc(f.name)}">${dir ? `<span class="dir">${esc(dir)}</span>` : ""}${esc(base)}</div>
      <div class="row-meta">${meta.join("")}</div>
      ${tags}
      ${preview}
    </div>
    <div class="row-actions">${actions}</div>
  </div>`;
}

// ---------------- 行内操作

async function onAction(e) {
  const btn = e.currentTarget;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  const item = [...state.files, ...state.trash].find((f) => f.id === id);

  try {
    if (act === "download") {
      // 用 a 触发，浏览器按 Content-Disposition 直接落盘
      const a = document.createElement("a");
      a.href = `${API}/files/${encodeURIComponent(id)}/download`;
      a.download = item ? item.name.split("/").pop() : "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }

    if (act === "trash") {
      if (!confirm(`把「${item ? item.name : "这个文件"}」移到回收站？`)) return;
      await api(`/files/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("已移到回收站", "ok");
      await refreshAll();
      return;
    }

    if (act === "restore") {
      await api(`/trash/${encodeURIComponent(id)}/restore`, { method: "POST", body: {} });
      toast("已还原", "ok");
      await refreshAll();
      return;
    }

    if (act === "purge") {
      if (!confirm(`彻底删除「${item ? item.name : "这个文件"}」？连同历史版本一起，无法恢复。`)) return;
      await api(`/trash/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("已彻底删除", "ok");
      await refreshAll();
      return;
    }

    if (act === "versions") return openVersions(id, item);

    if (act === "edit") return openEdit(id, item);
  } catch (err) {
    toast(err.message, "err");
  }
}

// ---------------- 版本历史

async function openVersions(id, item) {
  const dlg = $("#ver-dialog");
  $("#ver-title").textContent = `版本历史 · ${item ? item.name.split("/").pop() : ""}`;
  const body = $("#ver-body");
  body.innerHTML = `<p class="muted">读取中…</p>`;
  dlg.showModal();

  try {
    const data = await api(`/files/${encodeURIComponent(id)}`);
    const versions = data.versions || [];
    if (!versions.length) {
      body.innerHTML = `<p class="muted">还没有历史版本。同名文件被覆盖时，旧内容会自动存进这里（每个文件保留最近 10 份）。</p>`;
      return;
    }
    body.innerHTML = versions.map((v) => `
      <div class="ver-row">
        <span class="v-seq">v${esc(String(v.seq))}</span>
        <span class="v-meta">${esc(fullTime(v.savedAt))} · ${esc(formatBytes(v.size))}${v.note ? " · " + esc(v.note) : ""}</span>
        <button class="btn small" data-vact="download" data-seq="${esc(String(v.seq))}">下载</button>
        <button class="btn small" data-vact="restore" data-seq="${esc(String(v.seq))}">恢复</button>
      </div>`).join("");

    body.querySelectorAll("[data-vact]").forEach((b) => {
      b.addEventListener("click", async () => {
        const seq = b.dataset.seq;
        try {
          if (b.dataset.vact === "download") {
            const a = document.createElement("a");
            a.href = `${API}/files/${encodeURIComponent(id)}/versions/${encodeURIComponent(seq)}/download`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            return;
          }
          if (!confirm(`把当前内容回滚到 v${seq}？当前内容会先存成一个新版本，所以这次操作本身也能撤回。`)) return;
          await api(`/files/${encodeURIComponent(id)}/versions/${encodeURIComponent(seq)}/restore`, {
            method: "POST", body: {},
          });
          dlg.close();
          toast(`已回滚到 v${seq}`, "ok");
          await refreshAll();
        } catch (err) {
          toast(err.message, "err");
        }
      });
    });
  } catch (err) {
    body.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

// ---------------- 改名 / 标签

let editId = null;

function openEdit(id, item) {
  editId = id;
  $("#edit-name").value = item ? item.name : "";
  $("#edit-tags").value = item ? (item.tags || []).join(", ") : "";
  $("#edit-dialog").showModal();
  setTimeout(() => $("#edit-name").focus(), 40);
}

$("#edit-form").addEventListener("submit", async (e) => {
  // method="dialog" 的表单：先判是哪个按钮
  const submitter = e.submitter;
  if (!submitter || submitter.value !== "save") return;
  e.preventDefault();
  await saveEdit();
});

// 在输入框里按回车应当「保存」，而不是被浏览器选中的第一个按钮（取消）吃掉
$("#edit-form").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") {
    e.preventDefault();
    saveEdit();
  }
});

async function saveEdit() {
  if (!editId) return;
  const name = $("#edit-name").value.trim();
  const tags = $("#edit-tags").value.split(/[,，\s]+/).filter(Boolean);
  try {
    await api(`/files/${encodeURIComponent(editId)}`, { method: "PATCH", body: { name, tags } });
    $("#edit-dialog").close();
    toast("已保存", "ok");
    await refreshAll();
  } catch (err) {
    toast(err.message, "err");
  }
}

// ---------------- 上传

const dz = $("#dropzone");
const input = $("#file-input");
const progress = $("#up-progress");
const bar = progress.querySelector("i");
const ptext = progress.querySelector(".dz-text");

dz.addEventListener("click", () => input.click());
dz.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
});

input.addEventListener("change", () => {
  if (input.files && input.files.length) uploadFiles([...input.files]);
  input.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); })
);
["dragleave", "dragend"].forEach((ev) =>
  dz.addEventListener(ev, () => dz.classList.remove("over"))
);
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) uploadFiles(files);
});

// 页面别处也拖入时，避免浏览器直接打开文件
["dragover", "drop"].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    if (!dz.contains(e.target)) e.preventDefault();
  })
);

function uploadFiles(files) {
  const max = state.limits.maxFileBytes || 20 * 1024 * 1024;
  const tooBig = files.filter((f) => f.size > max);
  const ok = files.filter((f) => f.size <= max);
  if (tooBig.length) {
    toast(`${tooBig.map((f) => f.name).join("、")} 超过 ${formatBytes(max)}，已跳过`, "err");
  }
  if (!ok.length) return;

  const form = new FormData();
  for (const f of ok) form.append("file", f, f.name);
  form.append("sameName", "true");

  dz.classList.add("busy");
  progress.hidden = false;
  bar.style.width = "0%";
  ptext.textContent = `上传中… 0%（${ok.length} 个文件）`;

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${API}/files`);
  xhr.withCredentials = true;

  xhr.upload.addEventListener("progress", (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
    bar.style.width = pct + "%";
    ptext.textContent = `上传中… ${pct}%（${formatBytes(e.loaded)} / ${formatBytes(e.total)}）`;
  });

  xhr.addEventListener("load", async () => {
    dz.classList.remove("busy");
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }

    if (xhr.status === 401 || xhr.status === 403) {
      progress.hidden = true;
      showGate();
      toast("登录已失效，请重新登录", "err");
      return;
    }
    if (xhr.status < 200 || xhr.status >= 300 || !data || data.ok === false) {
      bar.style.width = "100%";
      ptext.textContent = "上传失败";
      toast((data && data.message) || `上传失败（HTTP ${xhr.status}）`, "err");
      setTimeout(() => { progress.hidden = true; }, 1600);
      return;
    }

    bar.style.width = "100%";
    const results = data.results || [];
    const count = (a) => results.filter((r) => r.action === a).length;
    const created = count("created") + count("created_duplicate");
    const versioned = count("versioned");
    const unchanged = count("unchanged");

    const bits = [];
    if (created) bits.push(`新增 ${created}`);
    if (versioned) bits.push(`更新 ${versioned}（旧版已存）`);
    if (unchanged) bits.push(`未变 ${unchanged}`);
    ptext.textContent = "完成 · " + (bits.join("，") || "无变化");
    toast(bits.join("，") || "没有变化", "ok");

    await refreshAll();
    setTimeout(() => { progress.hidden = true; }, 1400);
  });

  xhr.addEventListener("error", () => {
    dz.classList.remove("busy");
    progress.hidden = true;
    toast("网络中断，上传失败", "err");
  });

  xhr.send(form);
}

// ---------------- 工具栏

$("#search").addEventListener("input", (e) => {
  state.query = e.target.value;
  $("#search-clear").hidden = !state.query;
  renderList();
});

$("#search-clear").addEventListener("click", () => {
  state.query = "";
  $("#search").value = "";
  $("#search-clear").hidden = true;
  renderList();
});

$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  renderList();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.view = tab.dataset.view;
    render();
  });
});

$("#tagbar").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-tag]");
  if (!chip) return;
  state.tag = state.tag === chip.dataset.tag ? "" : chip.dataset.tag;
  renderTagbar();
  renderList();
});

$("#btn-export").addEventListener("click", async () => {
  if (!state.files.length) { toast("还没有文件可导出"); return; }
  const btn = $("#btn-export");
  btn.disabled = true;
  btn.textContent = "打包中…";
  try {
    const res = await api("/export", { raw: true });
    if (!res.ok) {
      let msg = `导出失败（HTTP ${res.status}）`;
      try { const d = await res.json(); msg = d.message || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="([^"]+)"/i.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : "csv-backup.zip";

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`已导出 ${formatBytes(blob.size)}`, "ok");
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "整包导出";
  }
});

// ---------------- 接口说明

$("#btn-api").addEventListener("click", () => {
  const origin = location.origin;
  $("#api-sample").textContent =
    `# 1. 用密码换会话（也可以直接用 API_TOKEN）\n` +
    `curl -c jar.txt -X POST ${origin}/api/login \\\n` +
    `     -H 'content-type: application/json' \\\n` +
    `     -d '{"password":"你的 ACCESS_PASSWORD"}'\n\n` +
    `# 2. 推送一个 CSV（原始字节流）\n` +
    `curl -b jar.txt -X POST '${origin}/api/files?name=库存表-2026-03.csv' \\\n` +
    `     -H 'content-type: text/csv' \\\n` +
    `     --data-binary @库存表-2026-03.csv\n\n` +
    `# 或者用长期令牌，省掉第 1 步：\n` +
    `curl -X POST '${origin}/api/files?name=库存表.csv' \\\n` +
    `     -H "Authorization: Bearer $API_TOKEN" \\\n` +
    `     -H 'content-type: text/csv' --data-binary @库存表.csv\n\n` +
    `# 3. 列出 / 下载\n` +
    `curl -b jar.txt ${origin}/api/files\n` +
    `curl -b jar.txt -OJ ${origin}/api/files/<id>/download\n\n` +
    `同名文件重复推送会自动留历史版本，比较省心。`;
  $("#api-dialog").showModal();
});

// ---------------- 启动

boot();
