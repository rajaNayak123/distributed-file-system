import React, { useState, useRef } from 'react';
import { runDirectUpload, type UploadProgress } from '@/utils/uploader';
import { formatBytes } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  UploadCloud,
  File,
  CheckCircle2,
  AlertCircle,
  X,
  Layers,
  Zap,
} from 'lucide-react';

interface UploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploadSuccess: () => void;
}

export const UploadModal: React.FC<UploadModalProps> = ({
  open,
  onOpenChange,
  onUploadSuccess,
}) => {
  const [selectedFile, setSelectedFile] = useState<globalThis.File | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isUploading =
    progress &&
    (progress.step === 'initiating' ||
      progress.step === 'uploading' ||
      progress.step === 'completing');

  const isMultipart = selectedFile && selectedFile.size > 50 * 1024 * 1024;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
      setProgress(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setSelectedFile(e.dataTransfer.files[0]);
      setProgress(null);
    }
  };

  const handleStartUpload = async () => {
    if (!selectedFile) return;

    abortControllerRef.current = new AbortController();

    try {
      await runDirectUpload({
        file: selectedFile,
        onUpdate: setProgress,
        signal: abortControllerRef.current.signal,
      });

      onUploadSuccess();
      setTimeout(() => {
        if (!isUploading) {
          handleClose();
        }
      }, 1500);
    } catch (err: any) {
      // Error handled in progress state
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setProgress(null);
    setSelectedFile(null);
  };

  const handleClose = () => {
    if (isUploading) return;
    setSelectedFile(null);
    setProgress(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px] border-slate-800 bg-slate-950/95 text-white shadow-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-bold">
            <UploadCloud className="h-5 w-5 text-indigo-400" />
            Direct-to-S3 File Upload
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-400">
            Bytes are streamed directly from your browser to Amazon S3 via presigned URLs.
          </DialogDescription>
        </DialogHeader>

        {!selectedFile ? (
          /* Dropzone */
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-all ${
              isDragging
                ? 'border-indigo-500 bg-indigo-500/10'
                : 'border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/60'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileChange}
              className="hidden"
            />
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400 mb-3">
              <UploadCloud className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold text-slate-200">
              Click to choose a file or drag and drop
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Supports any file up to 5 GB • Single & Multipart S3
            </p>
          </div>
        ) : (
          /* Selected File State */
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="flex items-center gap-3 overflow-hidden">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                  <File className="h-5 w-5" />
                </div>
                <div className="overflow-hidden">
                  <div className="truncate text-sm font-semibold text-slate-100">
                    {selectedFile.name}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{formatBytes(selectedFile.size)}</span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      {isMultipart ? (
                        <>
                          <Layers className="h-3 w-3 text-purple-400" />
                          <span className="text-purple-300">Multipart (&gt;50MB)</span>
                        </>
                      ) : (
                        <>
                          <Zap className="h-3 w-3 text-emerald-400" />
                          <span className="text-emerald-300">Direct Single-Part</span>
                        </>
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {!isUploading && progress?.step !== 'completed' && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSelectedFile(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>

            {/* Progress Display */}
            {progress && (
              <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-300 capitalize">
                    {progress.step === 'initiating' && 'Initiating S3 presigned session...'}
                    {progress.step === 'uploading' && 'Streaming bytes directly to S3...'}
                    {progress.step === 'completing' && 'Verifying with S3 HeadObject...'}
                    {progress.step === 'completed' && 'Upload Complete! Queued for SHA-256.'}
                    {progress.step === 'failed' && 'Upload Failed'}
                  </span>
                  <span className="font-mono text-indigo-400 font-bold">
                    {progress.percentage}%
                  </span>
                </div>

                <Progress value={progress.percentage} />

                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>
                    {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)}
                  </span>
                  {progress.speedBytesPerSec > 0 && progress.step === 'uploading' && (
                    <span>{formatBytes(progress.speedBytesPerSec)}/s</span>
                  )}
                </div>

                {progress.step === 'completed' && (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-400 mt-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>File uploaded and verified successfully.</span>
                  </div>
                )}

                {progress.error && (
                  <div className="flex items-center gap-1.5 text-xs text-rose-400 mt-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{progress.error}</span>
                  </div>
                )}
              </div>
            )}

            {/* Footer Buttons */}
            <div className="flex justify-end gap-2 pt-2">
              {isUploading ? (
                <Button variant="destructive" size="sm" onClick={handleCancel}>
                  Cancel Upload
                </Button>
              ) : progress?.step === 'completed' ? (
                <Button size="sm" onClick={handleClose}>
                  Done
                </Button>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => setSelectedFile(null)}>
                    Choose Another
                  </Button>
                  <Button size="sm" onClick={handleStartUpload}>
                    Start Upload
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
