import type { Method, MethodParams } from "./types";

export function applyMaskedMethod(
  current: ImageData,
  original: ImageData,
  mask: Uint8Array,
  method: Method,
  params: MethodParams
): ImageData {
  const w = current.width;
  const h = current.height;
  const longSide = Math.max(w, h);
  if (method === "black" || method === "white") {
    return fillSolid(current, mask, method === "black" ? 0 : 255);
  }
  if (method === "mosaic") {
    const blockPx = Math.max(2, Math.round((longSide * params.blockSize) / 100));
    return applyMosaic(current, mask, blockPx, w, h);
  }
  if (method === "blur") {
    const sigmaPx = Math.max(1, Math.round((longSide * params.blurSigma) / 100));
    return applyBlur(current, original, mask, sigmaPx, w, h);
  }
  return current;
}

export function eraseToOriginal(
  current: ImageData,
  original: ImageData,
  mask: Uint8Array
): ImageData {
  const out = new ImageData(new Uint8ClampedArray(current.data), current.width, current.height);
  const d = out.data;
  const o = original.data;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const p = i * 4;
      d[p] = o[p];
      d[p + 1] = o[p + 1];
      d[p + 2] = o[p + 2];
      d[p + 3] = o[p + 3];
    }
  }
  return out;
}

function fillSolid(current: ImageData, mask: Uint8Array, value: number): ImageData {
  const out = new ImageData(new Uint8ClampedArray(current.data), current.width, current.height);
  const d = out.data;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const p = i * 4;
      d[p] = value;
      d[p + 1] = value;
      d[p + 2] = value;
      d[p + 3] = 255;
    }
  }
  return out;
}

function applyMosaic(
  current: ImageData,
  mask: Uint8Array,
  blockSize: number,
  w: number,
  h: number
): ImageData {
  const out = new ImageData(new Uint8ClampedArray(current.data), w, h);
  const d = out.data;
  const block = Math.max(2, Math.round(blockSize));
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      let hasMask = false;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const xEnd = Math.min(bx + block, w);
      const yEnd = Math.min(by + block, h);
      for (let y = by; y < yEnd; y++) {
        for (let x = bx; x < xEnd; x++) {
          const idx = y * w + x;
          if (mask[idx]) hasMask = true;
          const p = idx * 4;
          r += d[p];
          g += d[p + 1];
          b += d[p + 2];
          a += d[p + 3];
          n++;
        }
      }
      if (!hasMask) continue;
      const avgR = Math.round(r / n);
      const avgG = Math.round(g / n);
      const avgB = Math.round(b / n);
      const avgA = Math.round(a / n);
      for (let y = by; y < yEnd; y++) {
        for (let x = bx; x < xEnd; x++) {
          const idx = y * w + x;
          if (!mask[idx]) continue;
          const p = idx * 4;
          d[p] = avgR;
          d[p + 1] = avgG;
          d[p + 2] = avgB;
          d[p + 3] = avgA;
        }
      }
    }
  }
  return out;
}

function applyBlur(
  current: ImageData,
  _original: ImageData,
  mask: Uint8Array,
  sigma: number,
  w: number,
  h: number
): ImageData {
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d")!;
  octx.putImageData(current, 0, 0);
  const blurred = document.createElement("canvas");
  blurred.width = w;
  blurred.height = h;
  const bctx = blurred.getContext("2d")!;
  bctx.filter = `blur(${Math.max(1, Math.round(sigma))}px)`;
  bctx.drawImage(off, 0, 0);
  const blurredData = bctx.getImageData(0, 0, w, h).data;
  const out = new ImageData(new Uint8ClampedArray(current.data), w, h);
  const d = out.data;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const p = i * 4;
      d[p] = blurredData[p];
      d[p + 1] = blurredData[p + 1];
      d[p + 2] = blurredData[p + 2];
      d[p + 3] = blurredData[p + 3];
    }
  }
  return out;
}

export function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("toBlob failed"));
      },
      mime,
      quality
    );
  });
}
