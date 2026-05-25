import {
  MODEL_VERSION,
  hashBlob,
  rebuildMask,
  runInference,
  type Detection,
  type InferenceResult,
} from "./infer";
import {
  readInferenceFile,
  writeInferenceFile,
  type InferenceCacheFile,
  type InferenceCacheRecord,
} from "./folderIO";
import type { ImageEntry } from "./types";

function quantizeSoft(soft: Float32Array): Uint8Array {
  const out = new Uint8Array(soft.length);
  for (let i = 0; i < soft.length; i++) {
    const v = soft[i];
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return out;
}

function dequantizeSoft(q: Uint8Array): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] / 255;
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < b.length; i += chunk) {
    const sub = b.subarray(i, i + chunk);
    s += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MASK_FORMAT = "soft-u8" as const;

function toDiskRecord(r: InferenceResult): InferenceCacheRecord {
  return {
    modelVersion: r.modelVersion,
    imageWidth: r.imageWidth,
    imageHeight: r.imageHeight,
    protoH: r.protoH,
    protoW: r.protoW,
    scale: r.scale,
    padX: r.padX,
    padY: r.padY,
    maskFormat: MASK_FORMAT,
    maskLRb64: bytesToB64(quantizeSoft(r.maskLR)),
    detections: r.detections,
    inferenceMs: r.inferenceMs,
  };
}

function fromDiskRecord(rec: InferenceCacheRecord): InferenceResult {
  const maskLR = dequantizeSoft(b64ToBytes(rec.maskLRb64));
  const mask = rebuildMask({
    maskLR,
    protoH: rec.protoH,
    protoW: rec.protoW,
    imageWidth: rec.imageWidth,
    imageHeight: rec.imageHeight,
    scale: rec.scale,
    padX: rec.padX,
    padY: rec.padY,
  });
  return {
    modelVersion: rec.modelVersion,
    imageWidth: rec.imageWidth,
    imageHeight: rec.imageHeight,
    detections: rec.detections as Detection[],
    mask,
    maskLR,
    protoH: rec.protoH,
    protoW: rec.protoW,
    scale: rec.scale,
    padX: rec.padX,
    padY: rec.padY,
    inferenceMs: rec.inferenceMs,
  };
}

export class InferenceCache {
  private rootHandle: FileSystemDirectoryHandle | null = null;
  private disk: Record<string, InferenceCacheRecord> = {};
  private mem = new Map<string, Promise<InferenceResult>>();
  private hashByEntryId = new Map<string, Promise<string>>();
  private chain: Promise<unknown> = Promise.resolve();
  private writeTimer: number | null = null;
  private writeQueued = false;

  setRoot(h: FileSystemDirectoryHandle | null): void {
    this.rootHandle = h;
  }

  reset(): void {
    this.disk = {};
    this.mem.clear();
    this.hashByEntryId.clear();
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.writeQueued = false;
    this.chain = Promise.resolve();
  }

  async loadFromDisk(): Promise<void> {
    if (!this.rootHandle) return;
    const file: InferenceCacheFile | null = await readInferenceFile(this.rootHandle);
    if (!file) return;
    if (file.modelVersion !== MODEL_VERSION) return;
    this.disk = file.records ?? {};
  }

  hashOf(entry: ImageEntry): Promise<string> {
    let p = this.hashByEntryId.get(entry.id);
    if (!p) {
      p = hashBlob(entry.file);
      this.hashByEntryId.set(entry.id, p);
    }
    return p;
  }

  async peek(entry: ImageEntry): Promise<InferenceResult | null> {
    const hash = await this.hashOf(entry);
    const memHit = this.mem.get(hash);
    if (memHit) return memHit;
    const diskHit = this.disk[hash];
    if (diskHit && diskHit.modelVersion === MODEL_VERSION && diskHit.maskFormat === MASK_FORMAT) {
      const result = fromDiskRecord(diskHit);
      this.mem.set(hash, Promise.resolve(result));
      return result;
    }
    return null;
  }

  async getOrRun(entry: ImageEntry): Promise<InferenceResult> {
    const hash = await this.hashOf(entry);
    const existing = this.mem.get(hash);
    if (existing) return existing;
    const diskHit = this.disk[hash];
    if (diskHit && diskHit.modelVersion === MODEL_VERSION && diskHit.maskFormat === MASK_FORMAT) {
      const p = Promise.resolve(fromDiskRecord(diskHit));
      this.mem.set(hash, p);
      return p;
    }
    const p = this.chain.then(async () => {
      const result = await runInference(entry.file);
      this.disk[hash] = toDiskRecord(result);
      this.scheduleWrite();
      return result;
    });
    this.chain = p.catch(() => undefined);
    this.mem.set(hash, p);
    return p;
  }

  prefetch(entry: ImageEntry): void {
    void this.getOrRun(entry).catch(() => undefined);
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) {
      this.writeQueued = true;
      return;
    }
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 800);
  }

  private async flush(): Promise<void> {
    if (!this.rootHandle) return;
    try {
      await writeInferenceFile(this.rootHandle, {
        version: 1,
        modelVersion: MODEL_VERSION,
        records: this.disk,
      });
    } catch (e) {
      console.warn("inference cache write failed", e);
    }
    if (this.writeQueued) {
      this.writeQueued = false;
      this.scheduleWrite();
    }
  }
}
