export type Method = "black" | "white" | "mosaic" | "blur";
export type Tool = "brush" | "lasso" | "eraser";

export interface MethodParams {
  blockSize: number;
  blurSigma: number;
}

export type ImageStatus = "pending" | "edited" | "saved";

export interface ImageEntry {
  id: string;
  relPath: string;
  folderPath: string;
  fileName: string;
  ext: string;
  file: File;
  fileHandle?: FileSystemFileHandle;
  status: ImageStatus;
  editedBlob?: Blob;
  error?: string;
}

export interface ProgressEntry {
  relPath: string;
  status: ImageStatus;
}

export interface ProgressFile {
  version: 1;
  rootName: string;
  lastUsedAt: number;
  entries: ProgressEntry[];
}
