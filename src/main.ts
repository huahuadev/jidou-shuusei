import "./style.css";
import JSZip from "jszip";
import { BeforeView } from "./beforeView";
import { Editor } from "./editor";
import { warmup, isSessionReady } from "./infer";
import { InferenceCache } from "./inferenceCache";
import { ImageLoader } from "./imageLoader";
import {
  deleteBackupFile,
  hasFsAccess,
  mimeForExt,
  pickInputViaFsAccess,
  readBackupBlob,
  readProgressFile,
  writeBackupFile,
  writeProgressFile,
} from "./folderIO";
import { canvasToBlob } from "./imageOps";
import type { ImageEntry, Method, MethodParams, ProgressFile, Tool } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const els = {
  stepInput: $<HTMLElement>("stepInput"),
  stepWarning: $<HTMLElement>("stepWarning"),
  stepEditor: $<HTMLElement>("stepEditor"),

  btnPickInputBig: $<HTMLButtonElement>("btnPickInputBig"),
  pickedFolderName: $<HTMLElement>("pickedFolderName"),
  fsUnsupported: $<HTMLElement>("fsUnsupported"),
  btnBackToInput: $<HTMLButtonElement>("btnBackToInput"),

  btnStartEditing: $<HTMLButtonElement>("btnStartEditing"),

  btnBackToWizard: $<HTMLButtonElement>("btnBackToWizard"),
  btnExportZip: $<HTMLButtonElement>("btnExportZip"),
  modeIndicator: $<HTMLSpanElement>("modeIndicator"),
  btnUndo: $<HTMLButtonElement>("btnUndo"),
  btnReset: $<HTMLButtonElement>("btnReset"),
  btnSave: $<HTMLButtonElement>("btnSave"),
  imageCount: $<HTMLSpanElement>("imageCount"),
  treeRoot: $<HTMLDivElement>("treeRoot"),
  sidebar: $<HTMLElement>("sidebar"),
  btnToggleSidebar: $<HTMLButtonElement>("btnToggleSidebar"),
  sidebarBadge: $<HTMLElement>("sidebarBadge"),
  beforeCanvas: $<HTMLCanvasElement>("beforeCanvas"),
  beforeOverlayCanvas: $<HTMLCanvasElement>("beforeOverlayCanvas"),
  beforeWrap: $<HTMLElement>("beforeWrap"),
  beforePlaceholder: $<HTMLParagraphElement>("beforePlaceholder"),
  autoBar: $<HTMLElement>("autoBar"),
  autoMethodSelect: $<HTMLSelectElement>("autoMethodSelect"),
  autoBlockSize: $<HTMLInputElement>("autoBlockSize"),
  autoBlockSizeVal: $<HTMLSpanElement>("autoBlockSizeVal"),
  autoBlurSigma: $<HTMLInputElement>("autoBlurSigma"),
  autoBlurSigmaVal: $<HTMLSpanElement>("autoBlurSigmaVal"),
  inferStatus: $<HTMLSpanElement>("inferStatus"),
  splitWrap: $<HTMLElement>("splitWrap"),
  splitDivider: $<HTMLElement>("splitDivider"),
  beforePane: $<HTMLElement>("beforePane"),
  afterLabel: $<HTMLElement>("afterLabel"),
  afterHint: $<HTMLElement>("afterHint"),
  btnPeekOriginal: $<HTMLButtonElement>("btnPeekOriginal"),
  btnClearAuto: $<HTMLButtonElement>("btnClearAuto"),
  savedBadge: $<HTMLElement>("savedBadge"),
  canvas: $<HTMLCanvasElement>("canvas"),
  lassoSvg: document.getElementById("lassoSvg") as unknown as SVGSVGElement,
  lassoPathOuter: document.getElementById("lassoPathOuter") as unknown as SVGPathElement,
  lassoPathInner: document.getElementById("lassoPathInner") as unknown as SVGPathElement,
  canvasPlaceholder: $<HTMLParagraphElement>("canvasPlaceholder"),
  brushCursor: $<HTMLDivElement>("brushCursor"),
  canvasWrap: $<HTMLElement>("canvasWrap"),
  currentPath: $<HTMLSpanElement>("currentPath"),
  saveStatus: $<HTMLSpanElement>("saveStatus"),
  methodSelect: $<HTMLSelectElement>("methodSelect"),
  brushSize: $<HTMLInputElement>("brushSize"),
  brushSizeVal: $<HTMLSpanElement>("brushSizeVal"),
  blockSize: $<HTMLInputElement>("blockSize"),
  blockSizeVal: $<HTMLSpanElement>("blockSizeVal"),
  blurSigma: $<HTMLInputElement>("blurSigma"),
  blurSigmaVal: $<HTMLSpanElement>("blurSigmaVal"),

  tutorialPopover: $<HTMLElement>("tutorialPopover"),
  tutorialStepNo: $<HTMLElement>("tutorialStepNo"),
  tutorialTitle: $<HTMLElement>("tutorialTitle"),
  tutorialText: $<HTMLElement>("tutorialText"),
  btnTutorialNext: $<HTMLButtonElement>("btnTutorialNext"),
  btnShowTutorial: $<HTMLButtonElement>("btnShowTutorial"),

  sidebarFilter: $<HTMLElement>("sidebarFilter"),

  doneOverlay: $<HTMLElement>("doneOverlay"),
  modelLoadingOverlay: $<HTMLElement>("modelLoadingOverlay"),
  doneIcon: $<HTMLElement>("doneIcon"),
  doneTitle: $<HTMLElement>("doneTitle"),
  doneText: $<HTMLElement>("doneText"),
  btnDoneFilterPending: $<HTMLButtonElement>("btnDoneFilterPending"),
  btnDoneZip: $<HTMLButtonElement>("btnDoneZip"),
  btnDoneClose: $<HTMLButtonElement>("btnDoneClose"),

  zipModal: $<HTMLElement>("zipModal"),
  zipModalOverlay: $<HTMLElement>("zipModalOverlay"),
  zipModalCount: $<HTMLElement>("zipModalCount"),
  btnCloseZipModal: $<HTMLButtonElement>("btnCloseZipModal"),
  btnZipDownload: $<HTMLButtonElement>("btnZipDownload"),
};

type Step = "input" | "warning" | "editor";
type FilterMode = "all" | "pending" | "done";

const TUTORIAL_SEEN_KEY = "jidou-shuusei:tutorial-seen";
const SIDEBAR_COLLAPSED_KEY = "jidou-shuusei:sidebar-collapsed";
const SPLIT_RATIO_KEY = "jidou-shuusei:split-ratio";
const AUTO_BLOCK_KEY = "jidou-shuusei:auto-block";
const AUTO_BLUR_KEY = "jidou-shuusei:auto-blur";
const FILTER_MODE_KEY = "jidou-shuusei:filter-mode";

function loadFilterMode(): FilterMode {
  try {
    const v = localStorage.getItem(FILTER_MODE_KEY);
    if (v === "all" || v === "pending" || v === "done") return v;
  } catch { /* ignore */ }
  return "all";
}

const state = {
  step: "input" as Step,
  rootName: "",
  rootInputHandle: null as FileSystemDirectoryHandle | null,
  entries: [] as ImageEntry[],
  activeIndex: -1,
  hasFs: hasFsAccess(),
  filterMode: loadFilterMode(),
};

function loadNum(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  } catch { return fallback; }
}

const autoState = {
  method: "black" as Method,
  blockSize: loadNum(AUTO_BLOCK_KEY, 4.0, 0.2, 10),
  blurSigma: loadNum(AUTO_BLUR_KEY, 4.0, 0.2, 10),
};

const editor = new Editor(els.canvas, (s) => {
  els.btnUndo.disabled = !s.canUndo;
  els.btnSave.disabled = !s.hasImage;
  els.btnPeekOriginal.disabled = !s.hasImage;
  const entry = state.entries[state.activeIndex];
  const locked = entry?.status === "saved";
  els.btnClearAuto.disabled = !s.dirty || locked;
});
editor.setLassoSvg(els.lassoSvg, els.lassoPathOuter, els.lassoPathInner);
const beforeView = new BeforeView(els.beforeCanvas, els.beforeOverlayCanvas);
const inferenceCache = new InferenceCache();
const imageLoader = new ImageLoader();
const PREFETCH_AHEAD = 2;

async function persistProgress(): Promise<void> {
  if (!state.hasFs || !state.rootInputHandle) return;
  const progress: ProgressFile = {
    version: 1,
    rootName: state.rootName,
    lastUsedAt: Date.now(),
    entries: state.entries.map((e) => ({ relPath: e.relPath, status: e.status })),
  };
  try {
    await writeProgressFile(state.rootInputHandle, progress);
  } catch (e) {
    console.warn("progress write failed", e);
  }
}

function setStep(step: Step) {
  state.step = step;
  els.stepInput.hidden = step !== "input";
  els.stepWarning.hidden = step !== "warning";
  els.stepEditor.hidden = step !== "editor";
}

function applyFsSupport() {
  if (state.hasFs) return;
  els.fsUnsupported.hidden = false;
  els.btnPickInputBig.disabled = true;
}

function setModeIndicator() {
  if (state.rootInputHandle) {
    els.modeIndicator.textContent = `読み込み先: ${state.rootName}/`;
  } else {
    els.modeIndicator.textContent = "—";
  }
}

function applySidebarCollapsed(collapsed: boolean) {
  els.sidebar.classList.toggle("collapsed", collapsed);
  els.btnToggleSidebar.title = collapsed ? "サイドバーを開く" : "サイドバーを折りたたむ";
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ }
}

function loadSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
}

function applySplitRatio(ratio: number, persist: boolean): void {
  const r = Math.min(0.8, Math.max(0.2, ratio));
  els.beforePane.style.flex = `0 0 ${(r * 100).toFixed(2)}%`;
  editor.refit();
  beforeView.resize();
  if (persist) {
    try { localStorage.setItem(SPLIT_RATIO_KEY, String(r)); } catch { /* ignore */ }
  }
}

function loadSplitRatio(): number {
  try {
    const v = localStorage.getItem(SPLIT_RATIO_KEY);
    if (v === null) return 0.5;
    const n = Number(v);
    if (!Number.isFinite(n)) return 0.5;
    return Math.min(0.8, Math.max(0.2, n));
  } catch { return 0.5; }
}

function filterMatches(e: ImageEntry, mode: FilterMode = state.filterMode): boolean {
  if (mode === "all") return true;
  if (mode === "pending") return e.status === "pending";
  if (mode === "done") return e.status === "edited" || e.status === "saved";
  return true;
}

function nextInFilter(from: number): number {
  for (let i = from + 1; i < state.entries.length; i++) {
    if (filterMatches(state.entries[i])) return i;
  }
  return -1;
}

function prevInFilter(from: number): number {
  for (let i = from - 1; i >= 0; i--) {
    if (filterMatches(state.entries[i])) return i;
  }
  return -1;
}

function applyFilterChipUi(): void {
  els.sidebarFilter.querySelectorAll<HTMLElement>(".filter-chip").forEach((el) => {
    el.classList.toggle("active", el.dataset.filter === state.filterMode);
  });
}

function setFilter(mode: FilterMode): void {
  state.filterMode = mode;
  try { localStorage.setItem(FILTER_MODE_KEY, mode); } catch { /* ignore */ }
  applyFilterChipUi();
  renderTree();
}

function renderTree() {
  const total = state.entries.length;
  const saved = state.entries.filter((e) => e.status === "saved").length;
  const visibleEntries = state.entries.filter((e) => filterMatches(e));
  els.imageCount.textContent =
    state.filterMode === "all" ? String(total) : `${visibleEntries.length}/${total}`;
  els.sidebarBadge.textContent = `${saved}/${total}`;
  els.sidebarBadge.title = `保存済 ${saved} / 全 ${total} 件 — クリックで一覧を開く`;
  if (total === 0) {
    els.treeRoot.innerHTML = '<p class="empty">画像がありません。</p>';
    return;
  }
  if (visibleEntries.length === 0) {
    const label = state.filterMode === "pending" ? "未編集" : "編集済";
    els.treeRoot.innerHTML = `<p class="empty">${label}の画像はありません。</p>`;
    return;
  }
  const byFolder = new Map<string, ImageEntry[]>();
  for (const e of visibleEntries) {
    const arr = byFolder.get(e.folderPath) ?? [];
    arr.push(e);
    byFolder.set(e.folderPath, arr);
  }
  const folders = Array.from(byFolder.keys()).sort();
  const frag = document.createDocumentFragment();
  for (const folder of folders) {
    const group = document.createElement("div");
    group.className = "tree-folder";
    const head = document.createElement("div");
    head.className = "tree-folder-head";
    head.textContent = folder === "" ? "(ルート)" : folder + "/";
    group.appendChild(head);
    for (const entry of byFolder.get(folder)!) {
      const row = document.createElement("div");
      row.className = "tree-image";
      if (state.entries[state.activeIndex]?.id === entry.id) row.classList.add("active");
      const name = document.createElement("span");
      name.className = "tree-image-name";
      name.textContent = entry.fileName;
      const status = document.createElement("span");
      const isErr = !!entry.error;
      status.className = `tree-image-status ${isErr ? "err" : entry.status}`;
      status.textContent = isErr
        ? "失敗"
        : entry.status === "saved"
          ? "保存済"
          : entry.status === "edited"
            ? "編集済"
            : "未";
      if (isErr && entry.error) status.title = entry.error;
      row.appendChild(name);
      row.appendChild(status);
      row.addEventListener("click", () => {
        const idx = state.entries.indexOf(entry);
        if (idx >= 0) void selectEntry(idx);
      });
      group.appendChild(row);
    }
    frag.appendChild(group);
  }
  els.treeRoot.replaceChildren(frag);
  const activeRow = els.treeRoot.querySelector(".tree-image.active") as HTMLElement | null;
  if (activeRow) {
    activeRow.scrollIntoView({ block: "center", behavior: "auto" });
  }
}

let inferToken = 0;

async function selectEntry(index: number) {
  if (index < 0 || index >= state.entries.length) return;
  state.activeIndex = index;
  const entry = state.entries[index];
  els.currentPath.textContent = entry.relPath;
  els.canvasPlaceholder.style.display = "none";
  els.beforePlaceholder.style.display = "none";
  updateSaveStatusText();
  els.beforeWrap.classList.remove("has-overlay");
  beforeView.clearOverlay();
  beforeView.setOverlayVisible(true);
  if (entry.editedBlob) {
    const [editedBitmap, originalBitmap] = await Promise.all([
      createImageBitmap(entry.editedBlob),
      imageLoader.get(entry, entry.file),
    ]);
    try {
      editor.loadFromBitmap(editedBitmap);
    } finally {
      editedBitmap.close();
    }
    beforeView.loadFromBitmap(originalBitmap);
  } else {
    const bitmap = await imageLoader.get(entry, entry.file);
    editor.loadFromBitmap(bitmap);
    beforeView.loadFromBitmap(bitmap);
  }
  editor.setAutoMethod(autoState.method, currentAutoParams());
  applyLockForEntry(entry);
  renderTree();
  void runInferenceForEntry(entry, ++inferToken);
}

function setInferStatus(text: string, kind: "" | "running" | "done" | "err") {
  els.inferStatus.textContent = text;
  els.inferStatus.className = "infer-status" + (kind ? ` ${kind}` : "");
}

function currentAutoParams(): MethodParams {
  return {
    blockSize: autoState.blockSize,
    blurSigma: autoState.blurSigma,
  };
}

function applyAutoResult(
  mask: Uint8Array,
  w: number,
  h: number,
  _numDet: number,
  _fromCache: boolean,
  _inferenceMs: number
) {
  beforeView.drawOverlay(mask, w, h);
  els.beforeWrap.classList.add("has-overlay");
  beforeView.setOverlayVisible(true);
  editor.setAutoMethod(autoState.method, currentAutoParams());
  editor.setAutoMask(mask);
  setInferStatus(editor.hasAuto() ? "検出済" : "検出なし", "done");
}

async function runInferenceForEntry(entry: ImageEntry, token: number) {
  const alreadyEdited = entry.status === "saved" || entry.status === "edited" || !!entry.editedBlob;
  if (alreadyEdited) {
    setInferStatus("—", "");
    schedulePrefetch();
    return;
  }
  try {
    const cached = await inferenceCache.peek(entry);
    if (token !== inferToken) return;
    if (cached) {
      applyAutoResult(cached.mask, cached.imageWidth, cached.imageHeight, cached.detections.length, true, 0);
      schedulePrefetch();
      return;
    }
    setInferStatus("推論中…", "running");
    const result = await inferenceCache.getOrRun(entry);
    if (token !== inferToken) return;
    applyAutoResult(result.mask, result.imageWidth, result.imageHeight, result.detections.length, false, result.inferenceMs);
    schedulePrefetch();
  } catch (e: any) {
    if (token !== inferToken) return;
    setInferStatus(`推論失敗: ${e?.message ?? e}`, "err");
    console.error("inference failed", e);
  }
}

function applyAutoMethodToUi() {
  els.autoBar.dataset.method = autoState.method;
}

function pushAutoToEditor() {
  const idx = state.activeIndex;
  if (idx < 0) return;
  const entry = state.entries[idx];
  if (entry.status === "saved") return;
  editor.setAutoMethod(autoState.method, currentAutoParams());
}

function onAutoMethodChange() {
  const v = els.autoMethodSelect.value as Method;
  autoState.method = v;
  applyAutoMethodToUi();
  pushAutoToEditor();
}

function schedulePrefetch() {
  const start = state.activeIndex + 1;
  const end = Math.min(state.entries.length, start + PREFETCH_AHEAD);
  for (let i = start; i < end; i++) {
    const e = state.entries[i];
    if (!e) continue;
    imageLoader.prefetch(e, e.file);
    if (e.status === "saved" || e.status === "edited" || e.editedBlob) continue;
    inferenceCache.prefetch(e);
  }
}

function applyLockForEntry(entry: ImageEntry) {
  const saved = entry.status === "saved";
  editor.setLocked(saved);
  els.savedBadge.hidden = !saved;
  els.afterHint.hidden = saved;
}

function onLockedEditAttempt() {
  const ok = confirm(
    "この画像は保存済みです。\n\nリセットして元の画像から編集し直しますか？"
  );
  if (ok) void onReset();
}

async function mergeFromBackup(
  rootHandle: FileSystemDirectoryHandle,
  entries: ImageEntry[],
  progress: ProgressFile
): Promise<void> {
  const statusMap = new Map(progress.entries.map((e) => [e.relPath, e.status]));
  for (const entry of entries) {
    const prev = statusMap.get(entry.relPath);
    if (!prev) continue;
    entry.status = prev;
    if (prev === "edited" || prev === "saved") {
      const blob = await readBackupBlob(rootHandle, entry.relPath);
      if (blob) entry.editedBlob = blob;
    }
  }
}

async function onPickInput() {
  try {
    let rootName: string;
    let entries: ImageEntry[];
    const picked = await pickInputViaFsAccess();
    rootName = picked.rootName;
    entries = picked.entries;
    const rootHandle: FileSystemDirectoryHandle = picked.rootHandle;

    let hasResume = false;
    const progress = await readProgressFile(rootHandle);
    if (progress) {
      const saved = progress.entries.filter((e) => e.status === "saved").length;
      const edited = progress.entries.filter((e) => e.status === "edited").length;
      if (saved + edited > 0) {
        await mergeFromBackup(rootHandle, entries, progress);
        hasResume = true;
      }
    }

    state.rootName = rootName;
    state.entries = entries;
    state.activeIndex = -1;
    state.rootInputHandle = rootHandle;

    inferenceCache.reset();
    inferenceCache.setRoot(rootHandle);
    await inferenceCache.loadFromDisk();

    await persistProgress();

    if (hasResume && entries.length > 0) {
      await startEditing();
      return;
    }

    if (entries.length === 0) {
      alert("画像が見つかりませんでした。jpg / png / webp が含まれるフォルダを選んでください。");
      return;
    }
    els.pickedFolderName.textContent = rootName;
    els.btnStartEditing.disabled = false;
    setStep("warning");
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    alert(`入力フォルダ取得失敗: ${e?.message ?? e}`);
  }
}

async function startEditing() {
  setStep("editor");
  setModeIndicator();
  renderTree();
  if (!isSessionReady()) {
    els.modelLoadingOverlay.hidden = false;
    try {
      await warmup();
    } finally {
      els.modelLoadingOverlay.hidden = true;
    }
  }
  const firstPending = state.entries.findIndex((e) => e.status !== "saved");
  if (firstPending >= 0) await selectEntry(firstPending);
  else if (state.entries.length > 0) await selectEntry(0);
  maybeShowTutorial();
}

type TutorialStep = {
  target: () => HTMLElement | null;
  title: string;
  body: string;
};

const tutorialSteps: TutorialStep[] = [
  {
    target: () => els.beforePane,
    title: "修正箇所が自動で検出されます！",
    body: `こちらに検出結果が出ます。赤くなっている部分が、検出結果です。`,
  },
  {
    target: () => document.getElementById("afterPane"),
    title: "修正結果がこちら！編集もできます！",
    body: `右画面が<strong>修正結果</strong>です。<br />
      検出が足りない / 多すぎる箇所は、<strong>ここで直接編集</strong>できます
      (投げ縄・ブラシ・消しゴム)。`,
  },
  {
    target: () => els.autoMethodSelect.closest(".auto-bar-method") as HTMLElement,
    title: "修正の種類は変えられます！",
    body: `<strong>黒塗り / 白塗り / モザイク / ぼかし</strong> を切り替えられます。<br />
      モザイク・ぼかしの強度もここで調整できます。`,
  },
  {
    target: () => els.btnSave,
    title: "修正結果を保存！",
    body: `<kbd>S</kbd> キーでも保存可能です。保存すると次の画像を開きます。`,
  },
  {
    target: () => els.btnExportZip,
    title: "ZIP で保存！",
    body: `ここまでで保存されたデータをまとめて ZIP にしてダウンロードできます。`,
  },
  {
    target: () => null,
    title: "途中でやめても大丈夫",
    body: `タブを閉じても、<strong>同じフォルダをもう一度開けば続きから再開</strong> できます。<br />
      進捗は選んだフォルダ内の <code>_jidou-shuusei-edited/</code> に保存されています。`,
  },
];

let tutorialIdx = -1;

function maybeShowTutorial() {
  try {
    if (localStorage.getItem(TUTORIAL_SEEN_KEY) === "1") return;
  } catch {
    /* ignore */
  }
  showTutorial();
}

function showTutorial() {
  tutorialIdx = 0;
  renderTutorial();
}

function renderTutorial() {
  if (tutorialIdx < 0 || tutorialIdx >= tutorialSteps.length) {
    dismissTutorial();
    return;
  }
  const step = tutorialSteps[tutorialIdx];
  const target = step.target();
  clearHighlight();
  if (target) target.classList.add("highlight-pulse");

  els.tutorialStepNo.textContent = `${tutorialIdx + 1} / ${tutorialSteps.length}`;
  els.tutorialTitle.textContent = step.title;
  els.tutorialText.innerHTML = step.body;
  els.btnTutorialNext.textContent =
    tutorialIdx === tutorialSteps.length - 1 ? "わかった" : "次へ →";

  els.tutorialPopover.style.visibility = "hidden";
  els.tutorialPopover.hidden = false;
  els.tutorialPopover.classList.toggle("centered", !target);
  requestAnimationFrame(() => {
    if (target) positionTutorialAt(target);
    else centerTutorial();
    els.tutorialPopover.style.visibility = "";
  });
}

function centerTutorial() {
  const popRect = els.tutorialPopover.getBoundingClientRect();
  const left = Math.max(8, (window.innerWidth - popRect.width) / 2);
  const top = Math.max(8, (window.innerHeight - popRect.height) / 2);
  els.tutorialPopover.style.left = `${left}px`;
  els.tutorialPopover.style.top = `${top}px`;
  els.tutorialPopover.classList.remove("place-above");
}

function clearHighlight() {
  document
    .querySelectorAll(".highlight-pulse")
    .forEach((el) => el.classList.remove("highlight-pulse"));
}

function nextTutorial() {
  tutorialIdx++;
  if (tutorialIdx >= tutorialSteps.length) {
    dismissTutorial();
    return;
  }
  renderTutorial();
}

function dismissTutorial() {
  els.tutorialPopover.hidden = true;
  tutorialIdx = -1;
  clearHighlight();
  try {
    localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

function positionTutorialAt(target: HTMLElement) {
  const targetRect = target.getBoundingClientRect();
  const popRect = els.tutorialPopover.getBoundingClientRect();
  const margin = 12;

  const spaceBelow = window.innerHeight - targetRect.bottom;
  const placeAbove = spaceBelow < popRect.height + margin + 8;

  let left = targetRect.left + targetRect.width / 2 - popRect.width / 2;
  const maxLeft = window.innerWidth - popRect.width - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < 8) left = 8;

  const top = placeAbove
    ? targetRect.top - popRect.height - margin
    : targetRect.bottom + margin;

  els.tutorialPopover.style.left = `${left}px`;
  els.tutorialPopover.style.top = `${top}px`;
  els.tutorialPopover.classList.toggle("place-above", placeAbove);

  const arrow = els.tutorialPopover.querySelector(".tutorial-arrow") as HTMLElement;
  const arrowOffset = targetRect.left + targetRect.width / 2 - left - 7;
  arrow.style.left = `${Math.max(14, Math.min(popRect.width - 28, arrowOffset))}px`;
}

function backToWizard() {
  state.entries = [];
  state.activeIndex = -1;
  state.rootInputHandle = null;
  state.rootName = "";
  inferenceCache.reset();
  inferenceCache.setRoot(null);
  imageLoader.clear();
  editor.clear();
  editor.setLocked(false);
  beforeView.clear();
  els.beforeWrap.classList.remove("has-overlay");
  els.canvasPlaceholder.style.display = "block";
  els.beforePlaceholder.style.display = "block";
  setInferStatus("—", "");
  els.btnStartEditing.disabled = true;
  setStep("input");
}

type SaveJob = {
  entry: ImageEntry;
  canvas: HTMLCanvasElement;
};

const saveQueue: SaveJob[] = [];
let saveWorkerRunning = false;

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d");
  if (ctx) ctx.drawImage(src, 0, 0);
  return c;
}

function updateSaveStatusText() {
  const pending = saveQueue.length + (saveWorkerRunning ? 1 : 0);
  const failed = state.entries.filter((e) => e.error).length;
  const parts: string[] = [];
  if (pending > 0) parts.push(`保存中 ${pending} 件`);
  if (failed > 0) parts.push(`失敗 ${failed} 件`);
  if (parts.length === 0) {
    if (els.saveStatus.classList.contains("err")) return;
    els.saveStatus.textContent = "";
    els.saveStatus.className = "save-status";
  } else {
    els.saveStatus.textContent = parts.join(" / ");
    els.saveStatus.className = failed > 0 ? "save-status err" : "save-status ok";
  }
}

async function processSaveJob(job: SaveJob) {
  const { entry, canvas } = job;
  const mime = mimeForExt(entry.ext);
  const quality = mime === "image/jpeg" || mime === "image/webp" ? 0.92 : undefined;
  try {
    const blob = await canvasToBlob(canvas, mime, quality);
    entry.editedBlob = blob;
    if (state.hasFs && state.rootInputHandle) {
      await writeBackupFile(state.rootInputHandle, entry.relPath, blob);
      entry.status = "saved";
    } else {
      entry.status = "edited";
    }
    entry.error = undefined;
    if (state.hasFs) {
      await persistProgress();
    }
  } catch (e: any) {
    entry.error = e?.message ?? String(e);
    entry.status = "pending";
    console.error(`[save] ${entry.relPath}:`, e);
  }
}

async function runSaveWorker() {
  if (saveWorkerRunning) return;
  saveWorkerRunning = true;
  try {
    while (saveQueue.length > 0) {
      const job = saveQueue.shift()!;
      await processSaveJob(job);
      renderTree();
      updateSaveStatusText();
    }
  } finally {
    saveWorkerRunning = false;
    renderTree();
    updateSaveStatusText();
  }
}

async function onReset() {
  const idx = state.activeIndex;
  if (idx < 0) return;
  const entry = state.entries[idx];
  const hadEdit = entry.status === "edited" || entry.status === "saved" || !!entry.editedBlob;

  entry.editedBlob = undefined;
  entry.error = undefined;
  entry.status = "pending";

  if (hadEdit && state.hasFs && state.rootInputHandle) {
    try {
      await deleteBackupFile(state.rootInputHandle, entry.relPath);
    } catch (e) {
      console.warn("delete backup failed", e);
    }
    await persistProgress();
  }

  const bitmap = await imageLoader.get(entry, entry.file);
  editor.loadFromBitmap(bitmap);
  editor.setAutoMethod(autoState.method, currentAutoParams());
  applyLockForEntry(entry);
  renderTree();
  updateSaveStatusText();
  void runInferenceForEntry(entry, ++inferToken);
}

async function onSave() {
  const idx = state.activeIndex;
  if (idx < 0) return;
  const entry = state.entries[idx];
  const sourceCanvas = editor.exportCanvas();
  const cloned = cloneCanvas(sourceCanvas);

  entry.status = "edited";
  entry.error = undefined;
  saveQueue.push({ entry, canvas: cloned });
  renderTree();
  updateSaveStatusText();
  void runSaveWorker();

  const nextIdx = nextInFilter(idx);
  if (nextIdx >= 0) {
    await selectEntry(nextIdx);
  } else {
    showDoneOverlay();
  }
}

function showDoneOverlay() {
  const total = state.entries.length;
  const pending = state.entries.filter((e) => e.status === "pending").length;
  const done = total - pending;
  if (pending > 0) {
    els.doneIcon.textContent = "📍";
    els.doneTitle.textContent = "最後まで行きました";
    els.doneText.innerHTML = `未編集が <strong>${pending}</strong> 枚 残っています (全 ${total} 枚)`;
    els.btnDoneFilterPending.hidden = false;
  } else {
    els.doneIcon.textContent = "🎉";
    els.doneTitle.textContent = "すべて編集しました";
    els.doneText.innerHTML = `保存済 ${done} / ${total} 枚`;
    els.btnDoneFilterPending.hidden = true;
  }
  els.doneOverlay.hidden = false;
}

function closeDoneOverlay() {
  els.doneOverlay.hidden = true;
}

function openZipModal() {
  const targets = state.entries.filter((e) => e.editedBlob);
  els.zipModalCount.textContent = `(${targets.length} ファイル)`;
  els.btnZipDownload.disabled = targets.length === 0;
  els.zipModal.hidden = false;
}

function closeZipModal() {
  els.zipModal.hidden = true;
}

function outputRelPath(relPath: string, flat: boolean): string {
  if (!flat) return relPath;
  return relPath.replace(/\//g, "_");
}

async function onZipDownload() {
  const targets = state.entries.filter((e) => e.editedBlob);
  if (targets.length === 0) return;
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="zipStyle"]:checked'
  );
  const flat = checked?.value !== "structured";

  els.btnZipDownload.disabled = true;
  const prev = els.btnZipDownload.textContent;
  els.btnZipDownload.textContent = "ZIP 生成中…";
  try {
    const zip = new JSZip();
    for (const entry of targets) {
      const blob = entry.editedBlob!;
      const buf = await blob.arrayBuffer();
      zip.file(outputRelPath(entry.relPath, flat), buf);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `${state.rootName || "output"}_${flat ? "flat" : "structured"}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeZipModal();
    els.saveStatus.textContent = `ZIP を書き出しました (${flat ? "フラット" : "階層"} / ${targets.length} 件)`;
    els.saveStatus.className = "save-status ok";
  } catch (e: any) {
    alert(`ZIP 書き出し失敗: ${e?.message ?? e}`);
  } finally {
    els.btnZipDownload.textContent = prev;
    els.btnZipDownload.disabled = targets.length === 0;
  }
}

function bindUi() {
  els.btnPickInputBig.addEventListener("click", () => void onPickInput());
  els.btnBackToInput.addEventListener("click", () => setStep("input"));
  els.btnStartEditing.addEventListener("click", () => void startEditing());
  els.btnStartEditing.disabled = true;

  els.btnToggleSidebar.addEventListener("click", () => {
    applySidebarCollapsed(!els.sidebar.classList.contains("collapsed"));
  });
  els.sidebarBadge.addEventListener("click", () => applySidebarCollapsed(false));
  applySidebarCollapsed(loadSidebarCollapsed());

  applySplitRatio(loadSplitRatio(), false);

  const ro = new ResizeObserver(() => {
    editor.refit();
    beforeView.resize();
  });
  ro.observe(els.canvasWrap);
  ro.observe(els.beforeWrap);
  let splitDragId: number | null = null;
  els.splitDivider.addEventListener("pointerdown", (e) => {
    splitDragId = e.pointerId;
    els.splitDivider.setPointerCapture(e.pointerId);
    els.splitDivider.classList.add("dragging");
    document.body.style.userSelect = "none";
  });
  els.splitDivider.addEventListener("pointermove", (e) => {
    if (splitDragId === null) return;
    const rect = els.splitWrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    applySplitRatio(ratio, false);
  });
  const endSplitDrag = (e: PointerEvent) => {
    if (splitDragId === null) return;
    try { els.splitDivider.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    splitDragId = null;
    els.splitDivider.classList.remove("dragging");
    document.body.style.userSelect = "";
    const rect = els.splitWrap.getBoundingClientRect();
    if (rect.width > 0) {
      applySplitRatio((e.clientX - rect.left) / rect.width, true);
    }
  };
  els.splitDivider.addEventListener("pointerup", endSplitDrag);
  els.splitDivider.addEventListener("pointercancel", endSplitDrag);
  els.splitDivider.addEventListener("dblclick", () => applySplitRatio(0.5, true));

  els.btnBackToWizard.addEventListener("click", backToWizard);
  els.btnExportZip.addEventListener("click", () => {
    dismissTutorial();
    openZipModal();
  });
  els.btnZipDownload.addEventListener("click", () => void onZipDownload());
  els.btnCloseZipModal.addEventListener("click", closeZipModal);
  els.zipModalOverlay.addEventListener("click", closeZipModal);
  els.btnDoneZip.addEventListener("click", () => {
    closeDoneOverlay();
    openZipModal();
  });
  els.btnDoneClose.addEventListener("click", closeDoneOverlay);
  els.btnDoneFilterPending.addEventListener("click", () => {
    setFilter("pending");
    closeDoneOverlay();
    const firstPending = state.entries.findIndex((e) => e.status === "pending");
    if (firstPending >= 0) void selectEntry(firstPending);
  });

  applyFilterChipUi();
  els.sidebarFilter.querySelectorAll<HTMLElement>(".filter-chip").forEach((el) => {
    el.addEventListener("click", () => {
      const f = el.dataset.filter as FilterMode | undefined;
      if (f === "all" || f === "pending" || f === "done") setFilter(f);
    });
  });
  els.btnTutorialNext.addEventListener("click", nextTutorial);
  els.btnShowTutorial.addEventListener("click", showTutorial);
  els.autoMethodSelect.value = autoState.method;
  els.autoMethodSelect.addEventListener("change", onAutoMethodChange);
  applyAutoMethodToUi();

  els.autoBlockSize.value = String(autoState.blockSize);
  els.autoBlockSizeVal.textContent = autoState.blockSize.toFixed(1);
  els.autoBlockSize.addEventListener("input", () => {
    const v = Number(els.autoBlockSize.value);
    autoState.blockSize = v;
    els.autoBlockSizeVal.textContent = v.toFixed(1);
    try { localStorage.setItem(AUTO_BLOCK_KEY, String(v)); } catch { /* ignore */ }
    if (autoState.method === "mosaic") pushAutoToEditor();
  });

  els.autoBlurSigma.value = String(autoState.blurSigma);
  els.autoBlurSigmaVal.textContent = autoState.blurSigma.toFixed(1);
  els.autoBlurSigma.addEventListener("input", () => {
    const v = Number(els.autoBlurSigma.value);
    autoState.blurSigma = v;
    els.autoBlurSigmaVal.textContent = v.toFixed(1);
    try { localStorage.setItem(AUTO_BLUR_KEY, String(v)); } catch { /* ignore */ }
    if (autoState.method === "blur") pushAutoToEditor();
  });

  els.beforeWrap.addEventListener("click", () => {
    if (!els.beforeWrap.classList.contains("has-overlay")) return;
    beforeView.toggleOverlay();
  });
  let peeking = false;
  const setPeek = (on: boolean) => {
    if (peeking === on) return;
    if (els.btnPeekOriginal.disabled && on) return;
    peeking = on;
    editor.peekOriginal(on);
    els.btnPeekOriginal.classList.toggle("active", on);
  };
  els.btnPeekOriginal.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { els.btnPeekOriginal.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setPeek(true);
  });
  const endPeek = (e: PointerEvent) => {
    try { els.btnPeekOriginal.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    setPeek(false);
  };
  els.btnPeekOriginal.addEventListener("pointerup", endPeek);
  els.btnPeekOriginal.addEventListener("pointercancel", endPeek);
  window.addEventListener("blur", () => setPeek(false));

  els.btnClearAuto.addEventListener("click", () => {
    if (els.btnClearAuto.disabled) return;
    editor.resetAll();
    beforeView.clearOverlay();
    els.beforeWrap.classList.remove("has-overlay");
    setInferStatus("—", "");
  });

  window.addEventListener("resize", () => {
    if (!els.tutorialPopover.hidden && tutorialIdx >= 0) {
      const t = tutorialSteps[tutorialIdx].target();
      if (t) positionTutorialAt(t);
      else centerTutorial();
    }
  });

  els.btnUndo.addEventListener("click", () => editor.undo());
  els.btnReset.addEventListener("click", () => void onReset());
  els.btnSave.addEventListener("click", () => void onSave());
  editor.setOnLockedAttempt(onLockedEditAttempt);

  let currentTool: Tool = "lasso";
  let lastClientX = -1;
  let lastClientY = -1;
  let sizingAnchor: { x: number; y: number } | null = null;

  const updateCursor = () => {
    if (currentTool === "lasso") {
      els.brushCursor.hidden = true;
      return;
    }
    let cx: number;
    let cy: number;
    if (sizingAnchor) {
      cx = sizingAnchor.x;
      cy = sizingAnchor.y;
    } else {
      if (lastClientX < 0) { els.brushCursor.hidden = true; return; }
      const rect = els.canvas.getBoundingClientRect();
      const inside =
        lastClientX >= rect.left &&
        lastClientX <= rect.right &&
        lastClientY >= rect.top &&
        lastClientY <= rect.bottom;
      if (!inside) { els.brushCursor.hidden = true; return; }
      cx = lastClientX;
      cy = lastClientY;
    }
    const d = editor.getBrushCssDiameter();
    if (d <= 0) { els.brushCursor.hidden = true; return; }
    els.brushCursor.style.width = `${d}px`;
    els.brushCursor.style.height = `${d}px`;
    els.brushCursor.style.left = `${cx}px`;
    els.brushCursor.style.top = `${cy}px`;
    els.brushCursor.classList.toggle("eraser", currentTool === "eraser");
    els.brushCursor.hidden = false;
  };

  editor.setOnSizingStart((x, y) => {
    sizingAnchor = { x, y };
    updateCursor();
  });
  editor.setOnSizingEnd(() => {
    sizingAnchor = null;
    updateCursor();
  });

  document.querySelectorAll<HTMLInputElement>('input[name="tool"]').forEach((inp) => {
    inp.addEventListener("change", () => {
      if (inp.checked) {
        currentTool = inp.value as Tool;
        editor.setTool(currentTool);
        updateCursor();
      }
    });
  });

  window.addEventListener("pointermove", (e) => {
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    updateCursor();
  });
  window.addEventListener("pointerout", (e) => {
    if (e.relatedTarget === null) {
      lastClientX = -1;
      lastClientY = -1;
      updateCursor();
    }
  });
  els.methodSelect.addEventListener("change", () =>
    editor.setMethod(els.methodSelect.value as Method)
  );
  els.brushSize.addEventListener("input", () => {
    const v = Number(els.brushSize.value);
    els.brushSizeVal.textContent = v.toFixed(1);
    editor.setBrushPercent(v);
    updateCursor();
  });
  editor.setOnBrushPercentChange((p) => {
    els.brushSize.value = String(p);
    els.brushSizeVal.textContent = p.toFixed(1);
    updateCursor();
  });
  els.blockSize.addEventListener("input", () => {
    const v = Number(els.blockSize.value);
    els.blockSizeVal.textContent = v.toFixed(1);
    editor.setParams({ blockSize: v });
  });
  els.blurSigma.addEventListener("input", () => {
    const v = Number(els.blurSigma.value);
    els.blurSigmaVal.textContent = v.toFixed(1);
    editor.setParams({ blurSigma: v });
  });

  document.addEventListener("keydown", (e) => {
    if (state.step !== "editor") return;
    const target = e.target as HTMLElement | null;
    const inField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      editor.undo();
      return;
    }
    if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      if (!els.btnSave.disabled) void onSave();
    } else if (k === "arrowleft" || k === "a") {
      const prev = prevInFilter(state.activeIndex);
      if (prev >= 0) {
        e.preventDefault();
        void selectEntry(prev);
      }
    } else if (k === "arrowright" || k === "d") {
      const next = nextInFilter(state.activeIndex);
      if (next >= 0) {
        e.preventDefault();
        void selectEntry(next);
      }
    } else if (k === "z") {
      e.preventDefault();
      editor.undo();
    }
  });

  editor.setBrushPercent(Number(els.brushSize.value));
  editor.setParams({
    blockSize: Number(els.blockSize.value),
    blurSigma: Number(els.blurSigma.value),
  });
  editor.setMethod(els.methodSelect.value as Method);
}

applyFsSupport();
bindUi();
setStep("input");
void warmup();
