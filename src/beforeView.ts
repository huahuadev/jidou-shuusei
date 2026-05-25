const OVERLAY_RGBA: [number, number, number, number] = [255, 64, 64, 140];

export class BeforeView {
  private baseCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private baseCtx: CanvasRenderingContext2D;
  private overlayCtx: CanvasRenderingContext2D;
  private hasOverlay = false;
  private overlayVisible = true;

  constructor(baseCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement) {
    this.baseCanvas = baseCanvas;
    this.overlayCanvas = overlayCanvas;
    this.baseCtx = baseCanvas.getContext("2d")!;
    this.overlayCtx = overlayCanvas.getContext("2d")!;
  }

  async loadFromBlob(blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("画像読込失敗"));
        el.src = url;
      });
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      this.baseCanvas.width = w;
      this.baseCanvas.height = h;
      this.baseCtx.drawImage(img, 0, 0);
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
      this.overlayCtx.clearRect(0, 0, w, h);
      this.hasOverlay = false;
      this.fitSize();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  clear(): void {
    if (this.baseCanvas.width) {
      this.baseCtx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    }
    if (this.overlayCanvas.width) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
    this.baseCanvas.width = 0;
    this.baseCanvas.height = 0;
    this.overlayCanvas.width = 0;
    this.overlayCanvas.height = 0;
    this.hasOverlay = false;
  }

  drawOverlay(mask: Uint8Array, w: number, h: number): void {
    if (w !== this.baseCanvas.width || h !== this.baseCanvas.height) return;
    if (this.overlayCanvas.width !== w || this.overlayCanvas.height !== h) {
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
    }
    const imgData = this.overlayCtx.createImageData(w, h);
    const d = imgData.data;
    const [r, g, b, a] = OVERLAY_RGBA;
    for (let i = 0, j = 0; j < mask.length; j++, i += 4) {
      if (mask[j]) {
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = a;
      }
    }
    this.overlayCtx.putImageData(imgData, 0, 0);
    this.hasOverlay = true;
    this.applyOverlayVisibility();
  }

  clearOverlay(): void {
    if (this.overlayCanvas.width) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
    this.hasOverlay = false;
  }

  setOverlayVisible(v: boolean): void {
    this.overlayVisible = v;
    this.applyOverlayVisibility();
  }

  toggleOverlay(): boolean {
    if (!this.hasOverlay) return this.overlayVisible;
    this.overlayVisible = !this.overlayVisible;
    this.applyOverlayVisibility();
    return this.overlayVisible;
  }

  isOverlayVisible(): boolean {
    return this.overlayVisible;
  }

  hasOverlayDrawn(): boolean {
    return this.hasOverlay;
  }

  private applyOverlayVisibility(): void {
    this.overlayCanvas.classList.toggle("hide", !this.overlayVisible);
  }

  private fitSize(): void {
    const wrap = this.baseCanvas.closest(".canvas-wrap") as HTMLElement | null;
    if (!wrap) return;
    const maxW = wrap.clientWidth - 20;
    const maxH = wrap.clientHeight - 20;
    if (maxW <= 0 || maxH <= 0 || !this.baseCanvas.width || !this.baseCanvas.height) return;
    const ratio = this.baseCanvas.width / this.baseCanvas.height;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) { h = maxH; w = h * ratio; }
    const ws = `${w}px`;
    const hs = `${h}px`;
    this.baseCanvas.style.width = ws;
    this.baseCanvas.style.height = hs;
    this.overlayCanvas.style.width = ws;
    this.overlayCanvas.style.height = hs;
  }

  resize(): void {
    this.fitSize();
  }
}
