import type { ImageEntry, ProgressFile } from "./types";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
export const BACKUP_DIR = "_jidou-shuusei-edited";
export const PROGRESS_FILE = "progress.json";
export const INFERENCE_FILE = "inference.json";
export const README_FILE = "README.txt";
const README_TEXT = `このフォルダは じどーしゅーせー β が自動で作成しました。
編集済みの画像、編集進捗 (progress.json)、自動検出キャッシュ (inference.json) を保存しています。

- 配布前に丸ごと削除して構いません。
- 中の画像を直接いじらないでください (進捗とずれて壊れます)。
- 同じ入力フォルダをツールで再度開くと、このフォルダの進捗から再開します。
`;

function extOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function isImage(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}

function compareEntry(a: ImageEntry, b: ImageEntry): number {
  const f = a.folderPath.localeCompare(b.folderPath);
  if (f !== 0) return f;
  return a.fileName.localeCompare(b.fileName);
}

export function hasFsAccess(): boolean {
  return typeof (window as any).showDirectoryPicker === "function";
}

let entryCounter = 0;

async function walkDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  prefix: string,
  out: ImageEntry[]
): Promise<void> {
  for await (const [name, handle] of (dirHandle as any).entries() as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind === "directory") {
      if (prefix === "" && name === BACKUP_DIR) continue;
      await walkDirectoryHandle(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, out);
    } else {
      if (!isImage(name)) continue;
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      out.push({
        id: `${++entryCounter}`,
        relPath: `${prefix}${name}`,
        folderPath: prefix.replace(/\/$/, ""),
        fileName: name,
        ext: extOf(name),
        file,
        fileHandle,
        status: "pending",
      });
    }
  }
}

export async function pickInputViaFsAccess(): Promise<{
  rootName: string;
  rootHandle: FileSystemDirectoryHandle;
  entries: ImageEntry[];
}> {
  const rootHandle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({
    mode: "readwrite",
  });
  const entries: ImageEntry[] = [];
  await walkDirectoryHandle(rootHandle, "", entries);
  entries.sort(compareEntry);
  return { rootName: rootHandle.name, rootHandle, entries };
}

export async function enumerateFromHandle(
  rootHandle: FileSystemDirectoryHandle
): Promise<{ rootName: string; entries: ImageEntry[] }> {
  const entries: ImageEntry[] = [];
  await walkDirectoryHandle(rootHandle, "", entries);
  entries.sort(compareEntry);
  return { rootName: rootHandle.name, entries };
}

export function pickInputViaFallback(input: HTMLInputElement): Promise<{
  rootName: string;
  entries: ImageEntry[];
}> {
  return new Promise((resolve) => {
    const handler = () => {
      const files = Array.from(input.files || []);
      const entries: ImageEntry[] = [];
      let rootName = "input";
      for (const f of files) {
        const rel = (f as any).webkitRelativePath as string | undefined;
        if (!rel) continue;
        const parts = rel.split("/");
        if (parts.length >= 1) rootName = parts[0];
        const relPath = parts.slice(1).join("/");
        if (parts.includes(BACKUP_DIR)) continue;
        if (!isImage(f.name)) continue;
        entries.push({
          id: `${++entryCounter}`,
          relPath,
          folderPath: parts.slice(1, -1).join("/"),
          fileName: f.name,
          ext: extOf(f.name),
          file: f,
          status: "pending",
        });
      }
      entries.sort(compareEntry);
      input.removeEventListener("change", handler);
      input.value = "";
      resolve({ rootName, entries });
    };
    input.addEventListener("change", handler);
    input.click();
  });
}

async function getOrCreateDir(
  root: FileSystemDirectoryHandle,
  parts: string[]
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const p of parts) {
    dir = await dir.getDirectoryHandle(p, { create: true });
  }
  return dir;
}

async function ensureReadme(rootHandle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const dir = await rootHandle.getDirectoryHandle(BACKUP_DIR, { create: true });
    try {
      await dir.getFileHandle(README_FILE);
      return;
    } catch {
      const fh = await dir.getFileHandle(README_FILE, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([README_TEXT], { type: "text/plain;charset=utf-8" }));
      await w.close();
    }
  } catch {
    /* ignore */
  }
}

export async function writeBackupFile(
  rootHandle: FileSystemDirectoryHandle,
  relPath: string,
  blob: Blob
): Promise<void> {
  const parts = relPath.split("/").filter(Boolean);
  const dir = await getOrCreateDir(rootHandle, [BACKUP_DIR, ...parts.slice(0, -1)]);
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  await ensureReadme(rootHandle);
}

export async function deleteBackupFile(
  rootHandle: FileSystemDirectoryHandle,
  relPath: string
): Promise<void> {
  try {
    const parts = relPath.split("/").filter(Boolean);
    let dir = await rootHandle.getDirectoryHandle(BACKUP_DIR);
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    await (dir as any).removeEntry(parts[parts.length - 1]);
  } catch {
    /* ignore */
  }
}

export async function readBackupBlob(
  rootHandle: FileSystemDirectoryHandle,
  relPath: string
): Promise<Blob | null> {
  try {
    const parts = relPath.split("/").filter(Boolean);
    let dir = await rootHandle.getDirectoryHandle(BACKUP_DIR);
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1]);
    return await fh.getFile();
  } catch {
    return null;
  }
}

export async function writeProgressFile(
  rootHandle: FileSystemDirectoryHandle,
  progress: ProgressFile
): Promise<void> {
  const dir = await rootHandle.getDirectoryHandle(BACKUP_DIR, { create: true });
  const fh = await dir.getFileHandle(PROGRESS_FILE, { create: true });
  const writable = await fh.createWritable();
  await writable.write(new Blob([JSON.stringify(progress, null, 2)], { type: "application/json" }));
  await writable.close();
  await ensureReadme(rootHandle);
}

export async function readProgressFile(
  rootHandle: FileSystemDirectoryHandle
): Promise<ProgressFile | null> {
  try {
    const dir = await rootHandle.getDirectoryHandle(BACKUP_DIR);
    const fh = await dir.getFileHandle(PROGRESS_FILE);
    const f = await fh.getFile();
    const text = await f.text();
    const obj = JSON.parse(text) as ProgressFile;
    if (obj && obj.version === 1 && Array.isArray(obj.entries)) return obj;
    return null;
  } catch {
    return null;
  }
}

export interface InferenceCacheRecord {
  modelVersion: string;
  imageWidth: number;
  imageHeight: number;
  protoH: number;
  protoW: number;
  scale: number;
  padX: number;
  padY: number;
  maskFormat?: "soft-u8";
  maskLRb64: string;
  detections: Array<{
    bbox: [number, number, number, number];
    score: number;
    classId: number;
    polygon: Array<[number, number]>;
  }>;
  inferenceMs: number;
}

export interface InferenceCacheFile {
  version: 1;
  modelVersion: string;
  records: Record<string, InferenceCacheRecord>;
}

export async function readInferenceFile(
  rootHandle: FileSystemDirectoryHandle
): Promise<InferenceCacheFile | null> {
  try {
    const dir = await rootHandle.getDirectoryHandle(BACKUP_DIR);
    const fh = await dir.getFileHandle(INFERENCE_FILE);
    const f = await fh.getFile();
    const text = await f.text();
    const obj = JSON.parse(text) as InferenceCacheFile;
    if (obj?.version === 1 && obj.records) return obj;
    return null;
  } catch {
    return null;
  }
}

export async function writeInferenceFile(
  rootHandle: FileSystemDirectoryHandle,
  file: InferenceCacheFile
): Promise<void> {
  const dir = await rootHandle.getDirectoryHandle(BACKUP_DIR, { create: true });
  const fh = await dir.getFileHandle(INFERENCE_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([JSON.stringify(file)], { type: "application/json" }));
  await w.close();
  await ensureReadme(rootHandle);
}

export async function clearBackup(rootHandle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await (rootHandle as any).removeEntry(BACKUP_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

export function mimeForExt(ext: string): string {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}
