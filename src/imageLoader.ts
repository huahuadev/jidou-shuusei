import type { ImageEntry } from "./types";

const CAPACITY = 7;

type Cached = {
  bitmap: Promise<ImageBitmap>;
  blob: Blob;
};

export class ImageLoader {
  private map = new Map<string, Cached>();

  get(entry: ImageEntry, blob: Blob): Promise<ImageBitmap> {
    const existing = this.map.get(entry.id);
    if (existing && existing.blob === blob) {
      this.touch(entry.id, existing);
      return existing.bitmap;
    }
    if (existing) this.dispose(existing);
    const bitmap = createImageBitmap(blob);
    const entry2: Cached = { bitmap, blob };
    this.map.set(entry.id, entry2);
    this.evictIfNeeded();
    return bitmap;
  }

  prefetch(entry: ImageEntry, blob: Blob): void {
    void this.get(entry, blob).catch(() => undefined);
  }

  evict(entry: ImageEntry): void {
    const c = this.map.get(entry.id);
    if (!c) return;
    this.map.delete(entry.id);
    this.dispose(c);
  }

  clear(): void {
    for (const c of this.map.values()) this.dispose(c);
    this.map.clear();
  }

  private touch(id: string, c: Cached): void {
    this.map.delete(id);
    this.map.set(id, c);
  }

  private evictIfNeeded(): void {
    while (this.map.size > CAPACITY) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const c = this.map.get(oldestKey)!;
      this.map.delete(oldestKey);
      this.dispose(c);
    }
  }

  private dispose(c: Cached): void {
    c.bitmap.then((b) => b.close()).catch(() => undefined);
  }
}
