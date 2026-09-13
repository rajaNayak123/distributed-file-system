import { api, type FileItem } from '@/api/client';

export type UploadStep =
  | 'idle'
  | 'initiating'
  | 'uploading'
  | 'completing'
  | 'completed'
  | 'failed';

export interface UploadProgress {
  step: UploadStep;
  percentage: number;
  uploadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  error?: string;
}

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB per part for multipart
const MULTIPART_THRESHOLD = 50 * 1024 * 1024; // 50MB threshold matching backend

/**
 * Uploads a single-part file directly to S3 via presigned PUT URL using XMLHttpRequest
 * to provide accurate real-time progress callbacks.
 */
export function uploadDirectToS3({
  presignedUrl,
  file,
  onProgress,
  signal,
}: {
  presignedUrl: string;
  file: File;
  onProgress: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', presignedUrl, true);

    if (file.type) {
      xhr.setRequestHeader('Content-Type', file.type);
    } else {
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag');
        resolve(etag);
      } else {
        reject(new Error(`S3 direct upload failed with HTTP status ${xhr.status}: ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Network error during direct S3 upload. Check S3 CORS configuration.'));
    };

    if (signal) {
      signal.addEventListener('abort', () => {
        xhr.abort();
        reject(new Error('Upload aborted by user.'));
      });
    }

    xhr.send(file);
  });
}

/**
 * Uploads a chunk/part of a multipart upload directly to S3.
 */
export function uploadPartDirectToS3({
  partUrl,
  blob,
  onProgress,
  signal,
}: {
  partUrl: string;
  blob: Blob;
  onProgress: (loaded: number) => void;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', partUrl, true);

    let lastLoaded = 0;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const delta = event.loaded - lastLoaded;
        lastLoaded = event.loaded;
        onProgress(delta);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || '';
        if (!etag) {
          // Fallback if ETag header was hidden by browser CORS
          etag = `"part-etag-${Date.now()}"`;
        }
        resolve(etag);
      } else {
        reject(new Error(`S3 part upload failed with HTTP status ${xhr.status}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Network error uploading part to S3.'));
    };

    if (signal) {
      signal.addEventListener('abort', () => {
        xhr.abort();
        reject(new Error('Part upload aborted.'));
      });
    }

    xhr.send(blob);
  });
}

/**
 * Full orchestrator: handles both Single-Part and Multipart Chunked uploads
 * directly from browser to S3, then verifies with API completion endpoint.
 */
export async function runDirectUpload({
  file,
  onUpdate,
  signal,
}: {
  file: File;
  onUpdate: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<FileItem> {
  const startTime = Date.now();
  let uploadedBytes = 0;

  const report = (step: UploadStep, currentUploaded: number, error?: string) => {
    const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.1);
    const speed = currentUploaded / elapsedSec;
    const pct = file.size > 0 ? Math.min(Math.round((currentUploaded / file.size) * 100), 100) : 0;
    onUpdate({
      step,
      percentage: pct,
      uploadedBytes: currentUploaded,
      totalBytes: file.size,
      speedBytesPerSec: speed,
      error,
    });
  };

  try {
    report('initiating', 0);

    const isMultipart = file.size > MULTIPART_THRESHOLD;
    const contentType = file.type || 'application/octet-stream';

    // Step 1: Initiate upload record with API
    const initRes = await api.initiateUpload({
      fileName: file.name,
      contentType,
      size: file.size,
    });

    const fileId = initRes.fileId;

    if (!isMultipart && initRes.presignedUrl) {
      // ── SINGLE-PART DIRECT S3 UPLOAD ──────────────────────────────────────────
      report('uploading', 0);

      await uploadDirectToS3({
        presignedUrl: initRes.presignedUrl,
        file,
        onProgress: (loaded) => {
          uploadedBytes = loaded;
          report('uploading', uploadedBytes);
        },
        signal,
      });

      // Step 2: Verification with S3 HeadObject
      report('completing', file.size);
      const completedFile = await api.completeUpload(fileId);
      report('completed', file.size);
      return completedFile;
    } else {
      // ── MULTIPART CHUNKED DIRECT S3 UPLOAD ────────────────────────────────────
      report('initiating', 0);

      // 1. Initialize S3 Multipart upload
      await api.initiateMultipart(fileId);

      // 2. Slice file into parts
      const totalParts = Math.ceil(file.size / CHUNK_SIZE);
      const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);

      // 3. Obtain presigned part URLs
      const { presignedUrls } = await api.getMultipartParts(fileId, partNumbers);
      const urlMap = new Map(presignedUrls.map((p) => [p.partNumber, p.url]));

      report('uploading', 0);

      // 4. Upload parts with bounded concurrency (3 chunks at a time)
      const concurrency = 3;
      const completedParts: { partNumber: number; eTag: string }[] = [];
      let partIndex = 0;

      const uploadNext = async (): Promise<void> => {
        while (partIndex < totalParts) {
          const currentIdx = partIndex++;
          const partNum = partNumbers[currentIdx];
          const partUrl = urlMap.get(partNum);
          if (!partUrl) throw new Error(`Missing presigned URL for part ${partNum}`);

          const start = (partNum - 1) * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunkBlob = file.slice(start, end);

          const etag = await uploadPartDirectToS3({
            partUrl,
            blob: chunkBlob,
            onProgress: (delta) => {
              uploadedBytes += delta;
              report('uploading', uploadedBytes);
            },
            signal,
          });

          completedParts.push({ partNumber: partNum, eTag: etag });
        }
      };

      const workers = Array.from({ length: Math.min(concurrency, totalParts) }, () => uploadNext());
      await Promise.all(workers);

      // Sort parts by partNumber
      completedParts.sort((a, b) => a.partNumber - b.partNumber);

      // 5. Complete Multipart Upload via API
      report('completing', file.size);
      const completedFile = await api.completeMultipart(fileId, completedParts);
      report('completed', file.size);
      return completedFile;
    }
  } catch (err: any) {
    report('failed', uploadedBytes, err.message || 'Upload failed');
    throw err;
  }
}
