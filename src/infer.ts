import * as ort from "onnxruntime-web";

if (import.meta.env.PROD) {
  // Cloudflare Pages の単一ファイル 25 MiB 制限を避けるため
  // 本番のみ onnxruntime-web の wasm を jsDelivr CDN から取得する
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";
}

export const MODEL_VERSION = "bestv3";
const MODEL_URL = (import.meta.env.VITE_MODEL_URL as string | undefined) || "/models/bestv3.onnx";
const INPUT_SIZE = 1024;
const NUM_CLASSES = 3;
const NUM_MASK_COEFFS = 32;
const DEFAULT_CONF = 0.4;
const DEFAULT_IOU = 0.5;

export type Detection = {
  bbox: [number, number, number, number];
  score: number;
  classId: number;
  polygon: Array<[number, number]>;
};

export type InferenceResult = {
  modelVersion: string;
  imageWidth: number;
  imageHeight: number;
  detections: Detection[];
  mask: Uint8Array;
  maskLR: Float32Array;
  protoH: number;
  protoW: number;
  scale: number;
  padX: number;
  padY: number;
  inferenceMs: number;
};

export function rebuildMask(args: {
  maskLR: Float32Array;
  protoH: number;
  protoW: number;
  imageWidth: number;
  imageHeight: number;
  scale: number;
  padX: number;
  padY: number;
}): Uint8Array {
  return upsampleSoftBilinear(
    args.maskLR,
    args.protoH,
    args.protoW,
    args.imageWidth,
    args.imageHeight,
    args.scale,
    args.padX,
    args.padY
  );
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let sessionReady = false;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    }).then((s) => {
      sessionReady = true;
      return s;
    });
  }
  return sessionPromise;
}

export function isSessionReady(): boolean {
  return sessionReady;
}

export async function warmup(): Promise<void> {
  await getSession();
}

type Preprocessed = {
  tensor: ort.Tensor;
  origW: number;
  origH: number;
  scale: number;
  padX: number;
  padY: number;
};

async function preprocess(image: HTMLImageElement | ImageBitmap): Promise<Preprocessed> {
  const origW = "naturalWidth" in image ? image.naturalWidth : image.width;
  const origH = "naturalHeight" in image ? image.naturalHeight : image.height;

  const scale = Math.min(INPUT_SIZE / origW, INPUT_SIZE / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const padX = Math.floor((INPUT_SIZE - newW) / 2);
  const padY = Math.floor((INPUT_SIZE - newH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(image as CanvasImageSource, padX, padY, newW, newH);
  const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  const data = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  const src = imgData.data;
  for (let i = 0, j = 0; i < src.length; i += 4, j++) {
    data[j] = src[i] / 255;
    data[plane + j] = src[i + 1] / 255;
    data[2 * plane + j] = src[i + 2] / 255;
  }
  const tensor = new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  return { tensor, origW, origH, scale, padX, padY };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

type RawDet = {
  cx: number;
  cy: number;
  w: number;
  h: number;
  score: number;
  classId: number;
  coeffs: Float32Array;
};

function decodeOutput0(
  output0: Float32Array,
  numAnchors: number,
  confThresh: number
): RawDet[] {
  const dets: RawDet[] = [];
  for (let i = 0; i < numAnchors; i++) {
    let bestCls = 0;
    let bestScore = -Infinity;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const s = output0[(4 + c) * numAnchors + i];
      if (s > bestScore) {
        bestScore = s;
        bestCls = c;
      }
    }
    if (bestScore < confThresh) continue;
    const cx = output0[0 * numAnchors + i];
    const cy = output0[1 * numAnchors + i];
    const w = output0[2 * numAnchors + i];
    const h = output0[3 * numAnchors + i];
    const coeffs = new Float32Array(NUM_MASK_COEFFS);
    for (let k = 0; k < NUM_MASK_COEFFS; k++) {
      coeffs[k] = output0[(4 + NUM_CLASSES + k) * numAnchors + i];
    }
    dets.push({ cx, cy, w, h, score: bestScore, classId: bestCls, coeffs });
  }
  return dets;
}

function iou(a: RawDet, b: RawDet): number {
  const ax1 = a.cx - a.w / 2;
  const ay1 = a.cy - a.h / 2;
  const ax2 = a.cx + a.w / 2;
  const ay2 = a.cy + a.h / 2;
  const bx1 = b.cx - b.w / 2;
  const by1 = b.cy - b.h / 2;
  const bx2 = b.cx + b.w / 2;
  const by2 = b.cy + b.h / 2;
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const areaA = (ax2 - ax1) * (ay2 - ay1);
  const areaB = (bx2 - bx1) * (by2 - by1);
  return inter / (areaA + areaB - inter);
}

function nms(dets: RawDet[], iouThresh: number): RawDet[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const kept: RawDet[] = [];
  for (const d of sorted) {
    let drop = false;
    for (const k of kept) {
      if (k.classId === d.classId && iou(d, k) > iouThresh) {
        drop = true;
        break;
      }
    }
    if (!drop) kept.push(d);
  }
  return kept;
}

function decodeMaskLowres(
  proto: Float32Array,
  coeffs: Float32Array,
  protoH: number,
  protoW: number
): Float32Array {
  const out = new Float32Array(protoH * protoW);
  const plane = protoH * protoW;
  for (let i = 0; i < plane; i++) {
    let s = 0;
    for (let c = 0; c < NUM_MASK_COEFFS; c++) {
      s += proto[c * plane + i] * coeffs[c];
    }
    out[i] = sigmoid(s);
  }
  return out;
}

function accumulateSoftBbox(
  combined: Float32Array,
  maskLR: Float32Array,
  protoH: number,
  protoW: number,
  cx: number,
  cy: number,
  w: number,
  h: number
): void {
  const scaleM = INPUT_SIZE / protoW;
  const x1 = Math.max(0, Math.floor((cx - w / 2) / scaleM));
  const y1 = Math.max(0, Math.floor((cy - h / 2) / scaleM));
  const x2 = Math.min(protoW, Math.ceil((cx + w / 2) / scaleM));
  const y2 = Math.min(protoH, Math.ceil((cy + h / 2) / scaleM));
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const i = y * protoW + x;
      const v = maskLR[i];
      if (v > combined[i]) combined[i] = v;
    }
  }
}

const SOFT_THRESHOLD = 0.5;

function upsampleSoftBilinear(
  softLR: Float32Array,
  protoH: number,
  protoW: number,
  origW: number,
  origH: number,
  scale: number,
  padX: number,
  padY: number
): Uint8Array {
  const out = new Uint8Array(origW * origH);
  const scaleM = INPUT_SIZE / protoW;
  for (let y = 0; y < origH; y++) {
    // LR coordinate at center of full-res pixel
    const inputY = y * scale + padY;
    const lrYf = inputY / scaleM - 0.5;
    const y0 = Math.floor(lrYf);
    const fy = lrYf - y0;
    if (y0 + 1 < 0 || y0 >= protoH) continue;
    const y0c = Math.max(0, Math.min(protoH - 1, y0));
    const y1c = Math.max(0, Math.min(protoH - 1, y0 + 1));
    for (let x = 0; x < origW; x++) {
      const inputX = x * scale + padX;
      const lrXf = inputX / scaleM - 0.5;
      const x0 = Math.floor(lrXf);
      const fx = lrXf - x0;
      if (x0 + 1 < 0 || x0 >= protoW) continue;
      const x0c = Math.max(0, Math.min(protoW - 1, x0));
      const x1c = Math.max(0, Math.min(protoW - 1, x0 + 1));
      const v00 = softLR[y0c * protoW + x0c];
      const v01 = softLR[y0c * protoW + x1c];
      const v10 = softLR[y1c * protoW + x0c];
      const v11 = softLR[y1c * protoW + x1c];
      const v0 = v00 * (1 - fx) + v01 * fx;
      const v1 = v10 * (1 - fx) + v11 * fx;
      const v = v0 * (1 - fy) + v1 * fy;
      if (v > SOFT_THRESHOLD) out[y * origW + x] = 1;
    }
  }
  return out;
}

function extractPolygonFromBbox(
  cx: number,
  cy: number,
  w: number,
  h: number,
  scale: number,
  padX: number,
  padY: number
): Array<[number, number]> {
  const x1 = (cx - w / 2 - padX) / scale;
  const y1 = (cy - h / 2 - padY) / scale;
  const x2 = (cx + w / 2 - padX) / scale;
  const y2 = (cy + h / 2 - padY) / scale;
  return [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
}

export async function runInference(
  imageSource: Blob | HTMLImageElement | ImageBitmap,
  opts: { conf?: number; iou?: number } = {}
): Promise<InferenceResult> {
  const t0 = performance.now();
  const conf = opts.conf ?? DEFAULT_CONF;
  const iouThresh = opts.iou ?? DEFAULT_IOU;
  const session = await getSession();

  let img: HTMLImageElement | ImageBitmap;
  let cleanup: (() => void) | null = null;
  if (imageSource instanceof Blob) {
    const url = URL.createObjectURL(imageSource);
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image load failed"));
      el.src = url;
    });
    cleanup = () => URL.revokeObjectURL(url);
  } else {
    img = imageSource;
  }

  try {
    const pre = await preprocess(img);
    const feeds: Record<string, ort.Tensor> = {};
    feeds[session.inputNames[0]] = pre.tensor;
    const results = await session.run(feeds);

    const output0 = results[session.outputNames[0]];
    const output1 = results[session.outputNames[1]];
    const o0Data = output0.data as Float32Array;
    const o0Dims = output0.dims;
    const o1Data = output1.data as Float32Array;
    const o1Dims = output1.dims;

    const numAnchors = o0Dims[2];
    const protoH = o1Dims[2];
    const protoW = o1Dims[3];

    const rawDets = decodeOutput0(o0Data, numAnchors, conf);
    const keptDets = nms(rawDets, iouThresh);

    const combinedLR = new Float32Array(protoH * protoW);
    const detections: Detection[] = [];
    for (const d of keptDets) {
      const maskLR = decodeMaskLowres(o1Data, d.coeffs, protoH, protoW);
      accumulateSoftBbox(combinedLR, maskLR, protoH, protoW, d.cx, d.cy, d.w, d.h);
      const polygon = extractPolygonFromBbox(d.cx, d.cy, d.w, d.h, pre.scale, pre.padX, pre.padY);
      const x1 = (d.cx - d.w / 2 - pre.padX) / pre.scale;
      const y1 = (d.cy - d.h / 2 - pre.padY) / pre.scale;
      const x2 = (d.cx + d.w / 2 - pre.padX) / pre.scale;
      const y2 = (d.cy + d.h / 2 - pre.padY) / pre.scale;
      detections.push({
        bbox: [x1, y1, x2, y2],
        score: d.score,
        classId: d.classId,
        polygon,
      });
    }

    const mask = upsampleSoftBilinear(
      combinedLR,
      protoH,
      protoW,
      pre.origW,
      pre.origH,
      pre.scale,
      pre.padX,
      pre.padY
    );

    return {
      modelVersion: MODEL_VERSION,
      imageWidth: pre.origW,
      imageHeight: pre.origH,
      detections,
      mask,
      maskLR: combinedLR,
      protoH,
      protoW,
      scale: pre.scale,
      padX: pre.padX,
      padY: pre.padY,
      inferenceMs: performance.now() - t0,
    };
  } finally {
    if (cleanup) cleanup();
  }
}

export async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}
