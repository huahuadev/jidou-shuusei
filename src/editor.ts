import { applyMaskedMethod, eraseToOriginal } from "./imageOps";
import type { Method, MethodParams, Tool } from "./types";

export interface EditorState {
  hasImage: boolean;
  dirty: boolean;
  canUndo: boolean;
}

type ManualOp =
  | { kind: "fill"; mask: Uint8Array; method: Method; params: MethodParams }
  | { kind: "erase"; mask: Uint8Array };

export class Editor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private original: ImageData | null = null;
  private current: ImageData | null = null;

  private autoMask: Uint8Array | null = null;
  private autoMethod: Method = "black";
  private autoParams: MethodParams = { blockSize: 4.0, blurSigma: 4.0 };
  private manualOps: ManualOp[] = [];
  // Snapshot of `current` at the start of a drag — used as base for live preview.
  private dragBase: ImageData | null = null;

  private tool: Tool = "lasso";
  private method: Method = "black";
  private params: MethodParams = { blockSize: 4.0, blurSigma: 4.0 };
  private brushPercent = 3;

  private isDragging = false;
  private lastX = 0;
  private lastY = 0;
  private lassoPath: Array<{ x: number; y: number }> = [];
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private locked = false;
  private onLockedAttempt: (() => void) | null = null;

  private sizingStart: { clientX: number; clientY: number } | null = null;
  private onBrushPercentChange: ((p: number) => void) | null = null;
  private onSizingStart: ((anchorClientX: number, anchorClientY: number) => void) | null = null;
  private onSizingEnd: (() => void) | null = null;

  private lassoSvg: SVGSVGElement | null = null;
  private lassoPathOuter: SVGPathElement | null = null;
  private lassoPathInner: SVGPathElement | null = null;

  private onChange: (state: EditorState) => void;

  constructor(canvas: HTMLCanvasElement, onChange: (state: EditorState) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.previewCanvas = document.createElement("canvas");
    this.previewCtx = this.previewCanvas.getContext("2d")!;
    this.onChange = onChange;
    this.bindEvents();
  }

  setLassoSvg(svg: SVGSVGElement, outer: SVGPathElement, inner: SVGPathElement): void {
    this.lassoSvg = svg;
    this.lassoPathOuter = outer;
    this.lassoPathInner = inner;
    outer.setAttribute("fill", "none");
    outer.setAttribute("stroke", "rgba(0,0,0,0.75)");
    outer.setAttribute("stroke-width", "3");
    outer.setAttribute("stroke-linecap", "round");
    outer.setAttribute("stroke-linejoin", "round");
    outer.setAttribute("vector-effect", "non-scaling-stroke");
    inner.setAttribute("fill", "none");
    inner.setAttribute("stroke", "white");
    inner.setAttribute("stroke-width", "1.5");
    inner.setAttribute("stroke-linecap", "round");
    inner.setAttribute("stroke-linejoin", "round");
    inner.setAttribute("stroke-dasharray", "8 6");
    inner.setAttribute("vector-effect", "non-scaling-stroke");
  }

  private emit(): void {
    this.onChange({
      hasImage: this.original !== null,
      dirty: this.manualOps.length > 0 || this.hasAutoMask(),
      canUndo: this.manualOps.length > 0,
    });
  }

  private hasAutoMask(): boolean {
    if (!this.autoMask) return false;
    for (let i = 0; i < this.autoMask.length; i++) if (this.autoMask[i]) return true;
    return false;
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
      this.canvas.width = img.naturalWidth;
      this.canvas.height = img.naturalHeight;
      this.previewCanvas.width = img.naturalWidth;
      this.previewCanvas.height = img.naturalHeight;
      this.ctx.drawImage(img, 0, 0);
      const data = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      this.original = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
      this.current = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
      this.autoMask = null;
      this.manualOps = [];
      this.dragBase = null;
      this.lassoPath = [];
      if (this.lassoSvg) {
        this.lassoSvg.setAttribute("viewBox", `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
        this.setLassoVisible(false);
      }
      this.fitCanvasSize();
    } finally {
      URL.revokeObjectURL(url);
    }
    this.emit();
  }

  clear(): void {
    this.original = null;
    this.current = null;
    this.autoMask = null;
    this.manualOps = [];
    this.dragBase = null;
    this.lassoPath = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.setLassoVisible(false);
    this.emit();
  }

  private fitCanvasSize(): void {
    const wrap = this.canvas.closest(".canvas-wrap") as HTMLElement | null;
    if (!wrap) return;
    const maxW = wrap.clientWidth - 20;
    const maxH = wrap.clientHeight - 20;
    if (maxW <= 0 || maxH <= 0 || !this.canvas.width || !this.canvas.height) return;
    const ratio = this.canvas.width / this.canvas.height;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) { h = maxH; w = h * ratio; }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  setTool(t: Tool): void { this.tool = t; }
  setMethod(m: Method): void { this.method = m; }
  refit(): void { if (this.current) this.fitCanvasSize(); }
  setParams(p: Partial<MethodParams>): void { this.params = { ...this.params, ...p }; }
  setBrushPercent(p: number): void { this.brushPercent = p; }
  setLocked(v: boolean): void { this.locked = v; }
  setOnLockedAttempt(cb: (() => void) | null): void { this.onLockedAttempt = cb; }
  setOnBrushPercentChange(cb: ((p: number) => void) | null): void { this.onBrushPercentChange = cb; }
  setOnSizingStart(cb: ((anchorClientX: number, anchorClientY: number) => void) | null): void { this.onSizingStart = cb; }
  setOnSizingEnd(cb: (() => void) | null): void { this.onSizingEnd = cb; }

  // Set/replace the auto-detection mask. Triggers rebuild.
  setAutoMask(mask: Uint8Array | null): void {
    if (!this.original) {
      this.autoMask = null;
      return;
    }
    if (mask && mask.length !== this.original.width * this.original.height) {
      console.warn("auto mask size mismatch", mask.length, this.original.width * this.original.height);
      this.autoMask = null;
    } else {
      this.autoMask = mask;
    }
    this.rebuild();
    this.emit();
  }

  // Update auto method/params. Triggers rebuild.
  setAutoMethod(method: Method, params: MethodParams): void {
    this.autoMethod = method;
    this.autoParams = params;
    this.rebuild();
  }

  hasAuto(): boolean {
    return this.hasAutoMask();
  }

  getBrushCssDiameter(): number {
    if (!this.canvas.width) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? rect.width / this.canvas.width : 1;
    return this.brushRadius() * 2 * scale;
  }

  undo(): void {
    if (this.manualOps.length === 0) return;
    this.manualOps.pop();
    this.rebuild();
    this.emit();
  }

  resetAll(): void {
    if (!this.original) return;
    this.autoMask = null;
    this.manualOps = [];
    this.dragBase = null;
    this.rebuild();
    this.emit();
  }

  exportCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  peekOriginal(show: boolean): void {
    if (!this.original || !this.current) return;
    this.ctx.putImageData(show ? this.original : this.current, 0, 0);
  }

  // Recompose current = original → autoLayer → manualOps[*].
  private rebuild(): void {
    if (!this.original) return;
    let img = new ImageData(
      new Uint8ClampedArray(this.original.data),
      this.original.width,
      this.original.height
    );
    if (this.hasAutoMask()) {
      img = applyMaskedMethod(img, this.original, this.autoMask!, this.autoMethod, this.autoParams);
    }
    for (const op of this.manualOps) {
      if (op.kind === "erase") {
        img = eraseToOriginal(img, this.original, op.mask);
      } else {
        img = applyMaskedMethod(img, this.original, op.mask, op.method, op.params);
      }
    }
    this.current = img;
    this.repaint();
  }

  private repaint(): void {
    if (!this.current) return;
    this.ctx.putImageData(this.current, 0, 0);
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e));
    c.addEventListener("pointerleave", (e) => {
      if (this.isDragging) this.onUp(e);
    });
    window.addEventListener("resize", () => {
      if (this.current) this.fitCanvasSize();
    });
  }

  private toLocal(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    return { x, y };
  }

  private applySizingFromPointer(e: PointerEvent): void {
    if (!this.sizingStart) return;
    const dx = e.clientX - this.sizingStart.clientX;
    const dy = e.clientY - this.sizingStart.clientY;
    const cssRadius = Math.sqrt(dx * dx + dy * dy);
    const rect = this.canvas.getBoundingClientRect();
    const longSideCss = Math.max(rect.width, rect.height);
    if (longSideCss <= 0) return;
    // brushRadius_canvas = longSide_canvas * percent / 100
    // cssRadius = brushRadius_canvas * (rect.w / canvas.w) = longSide_canvas * percent / 100 * (rect.w / canvas.w)
    // Since rect mirrors longSide ratio: cssRadius = longSide_css * percent / 100
    const raw = (cssRadius / longSideCss) * 100;
    const rounded = Math.round(raw * 10) / 10;
    const clamped = Math.min(15, Math.max(0.5, rounded));
    if (clamped !== this.brushPercent) {
      this.brushPercent = clamped;
      if (this.onBrushPercentChange) this.onBrushPercentChange(clamped);
    }
  }

  private brushRadius(): number {
    if (!this.canvas.width) return 10;
    const longSide = Math.max(this.canvas.width, this.canvas.height);
    return (longSide * this.brushPercent) / 100;
  }

  private onDown(e: PointerEvent): void {
    if (!this.current) return;
    // Clip Studio shortcut: Ctrl+Alt (or Cmd+Alt) + drag = adjust brush size.
    // Anchor (click point) becomes the brush center; radius = distance from anchor to pointer.
    if ((e.ctrlKey || e.metaKey) && e.altKey && (this.tool === "brush" || this.tool === "eraser")) {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.sizingStart = { clientX: e.clientX, clientY: e.clientY };
      if (this.onSizingStart) this.onSizingStart(e.clientX, e.clientY);
      this.applySizingFromPointer(e);
      return;
    }
    if (this.locked) {
      if (this.onLockedAttempt) this.onLockedAttempt();
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.isDragging = true;
    const { x, y } = this.toLocal(e);
    this.lastX = x;
    this.lastY = y;
    // Snapshot current as drag base (so live preview composites on top of finalized state).
    this.dragBase = new ImageData(
      new Uint8ClampedArray(this.current.data),
      this.current.width,
      this.current.height
    );
    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    this.previewCtx.fillStyle = "white";
    if (this.tool === "lasso") {
      this.lassoPath = [{ x, y }];
      this.updateLassoSvg();
    } else if (this.tool === "eraser") {
      this.drawBrushDot(x, y);
      this.renderDragEraser();
    } else {
      this.drawBrushDot(x, y);
      this.renderDragBrush();
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.sizingStart) {
      this.applySizingFromPointer(e);
      return;
    }
    if (!this.isDragging || !this.current) return;
    const { x, y } = this.toLocal(e);
    if (this.tool === "lasso") {
      this.lassoPath.push({ x, y });
      this.updateLassoSvg();
    } else if (this.tool === "eraser") {
      this.drawBrushLine(this.lastX, this.lastY, x, y);
      this.lastX = x;
      this.lastY = y;
      this.renderDragEraser();
    } else {
      this.drawBrushLine(this.lastX, this.lastY, x, y);
      this.lastX = x;
      this.lastY = y;
      this.renderDragBrush();
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.sizingStart) {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
      this.sizingStart = null;
      if (this.onSizingEnd) this.onSizingEnd();
      return;
    }
    if (!this.isDragging) return;
    this.isDragging = false;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    if (!this.current || !this.original) {
      this.dragBase = null;
      return;
    }

    if (this.tool === "lasso") {
      if (this.lassoPath.length >= 3) {
        this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
        this.previewCtx.fillStyle = "white";
        this.fillSmoothPath(this.previewCtx, this.lassoPath);
      } else {
        this.lassoPath = [];
        this.updateLassoSvg();
        this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
        this.dragBase = null;
        return;
      }
      this.lassoPath = [];
      this.updateLassoSvg();
    }

    const mask = this.buildMaskFromPreview();
    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);

    if (!this.hasAnyMaskPixel(mask)) {
      this.dragBase = null;
      this.rebuild();
      return;
    }

    if (this.tool === "eraser") {
      this.manualOps.push({ kind: "erase", mask });
    } else {
      this.manualOps.push({ kind: "fill", mask, method: this.method, params: { ...this.params } });
    }
    this.dragBase = null;
    this.rebuild();
    this.emit();
  }

  private hasAnyMaskPixel(mask: Uint8Array): boolean {
    for (let i = 0; i < mask.length; i++) if (mask[i]) return true;
    return false;
  }

  // During eraser drag, show dragBase with preview mask erased to original.
  private renderDragEraser(): void {
    if (!this.dragBase || !this.original) return;
    const mask = this.buildMaskFromPreview();
    const img = eraseToOriginal(this.dragBase, this.original, mask);
    this.ctx.putImageData(img, 0, 0);
  }

  // During brush drag, apply the real method live (like eraser shows real result).
  private renderDragBrush(): void {
    if (!this.dragBase || !this.original) return;
    const mask = this.buildMaskFromPreview();
    const img = applyMaskedMethod(this.dragBase, this.original, mask, this.method, this.params);
    this.ctx.putImageData(img, 0, 0);
  }

  private drawBrushDot(x: number, y: number): void {
    const r = this.brushRadius();
    this.previewCtx.beginPath();
    this.previewCtx.arc(x, y, r, 0, Math.PI * 2);
    this.previewCtx.fill();
  }

  private drawBrushLine(x0: number, y0: number, x1: number, y1: number): void {
    const r = this.brushRadius();
    this.previewCtx.lineCap = "round";
    this.previewCtx.lineJoin = "round";
    this.previewCtx.lineWidth = r * 2;
    this.previewCtx.strokeStyle = "white";
    this.previewCtx.beginPath();
    this.previewCtx.moveTo(x0, y0);
    this.previewCtx.lineTo(x1, y1);
    this.previewCtx.stroke();
  }

  private setLassoVisible(visible: boolean): void {
    if (!this.lassoSvg) return;
    if (visible) {
      this.lassoSvg.removeAttribute("hidden");
      this.lassoSvg.style.display = "block";
    } else {
      this.lassoSvg.setAttribute("hidden", "");
      this.lassoSvg.style.display = "none";
    }
  }

  private updateLassoSvg(): void {
    if (!this.lassoSvg || !this.lassoPathOuter || !this.lassoPathInner) return;
    if (this.lassoPath.length === 0) {
      this.setLassoVisible(false);
      this.lassoPathOuter.setAttribute("d", "");
      this.lassoPathInner.setAttribute("d", "");
      return;
    }
    this.setLassoVisible(true);
    const d = this.buildSvgPathData(this.lassoPath);
    this.lassoPathOuter.setAttribute("d", d);
    this.lassoPathInner.setAttribute("d", d);
  }

  private buildSvgPathData(path: Array<{ x: number; y: number }>): string {
    if (path.length === 0) return "";
    if (path.length === 1) {
      const p = path[0];
      const r = 0.5;
      return `M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`;
    }
    let d = `M ${path[0].x} ${path[0].y}`;
    if (path.length < 3) {
      for (let i = 1; i < path.length; i++) d += ` L ${path[i].x} ${path[i].y}`;
      return d;
    }
    for (let i = 1; i < path.length - 1; i++) {
      const cx = (path[i].x + path[i + 1].x) / 2;
      const cy = (path[i].y + path[i + 1].y) / 2;
      d += ` Q ${path[i].x} ${path[i].y} ${cx} ${cy}`;
    }
    const last = path[path.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }

  private buildSmoothPath(
    ctx: CanvasRenderingContext2D,
    path: Array<{ x: number; y: number }>
  ): void {
    ctx.beginPath();
    if (path.length === 0) return;
    ctx.moveTo(path[0].x, path[0].y);
    if (path.length < 3) {
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
      return;
    }
    for (let i = 1; i < path.length - 1; i++) {
      const cx = (path[i].x + path[i + 1].x) / 2;
      const cy = (path[i].y + path[i + 1].y) / 2;
      ctx.quadraticCurveTo(path[i].x, path[i].y, cx, cy);
    }
    const last = path[path.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  private fillSmoothPath(
    ctx: CanvasRenderingContext2D,
    path: Array<{ x: number; y: number }>
  ): void {
    this.buildSmoothPath(ctx, path);
    ctx.closePath();
    ctx.fill();
  }

  private buildMaskFromPreview(): Uint8Array {
    const w = this.previewCanvas.width;
    const h = this.previewCanvas.height;
    const img = this.previewCtx.getImageData(0, 0, w, h);
    const mask = new Uint8Array(w * h);
    const d = img.data;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      if (d[i + 3] > 8) mask[j] = 1;
    }
    return mask;
  }
}
