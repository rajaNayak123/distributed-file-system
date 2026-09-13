import React, { useState } from 'react';
import { api, type FileItem } from '@/api/client';
import { formatBytes, formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Download,
  Trash2,
  RotateCw,
  Copy,
  Check,
  FileText,
  FileCode,
  FileArchive,
  Film,
  Music,
  Image as ImageIcon,
  File as DefaultFileIcon,
  ShieldCheck,
  Layers,
  AlertCircle,
  Loader2,
} from 'lucide-react';

interface FileCardProps {
  file: FileItem;
  onDeleted: (fileId: string) => void;
  onRetried: () => void;
}

function getFileIcon(contentType: string, fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (contentType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext || '')) {
    return <ImageIcon className="h-5 w-5 text-emerald-400" />;
  }
  if (contentType.startsWith('video/') || ['mp4', 'mov', 'mkv', 'avi'].includes(ext || '')) {
    return <Film className="h-5 w-5 text-purple-400" />;
  }
  if (contentType.startsWith('audio/') || ['mp3', 'wav', 'ogg'].includes(ext || '')) {
    return <Music className="h-5 w-5 text-pink-400" />;
  }
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext || '')) {
    return <FileArchive className="h-5 w-5 text-amber-400" />;
  }
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'json', 'html', 'css', 'go'].includes(ext || '')) {
    return <FileCode className="h-5 w-5 text-cyan-400" />;
  }
  if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(ext || '')) {
    return <FileText className="h-5 w-5 text-indigo-400" />;
  }
  return <DefaultFileIcon className="h-5 w-5 text-slate-400" />;
}

export const FileCard: React.FC<FileCardProps> = ({ file, onDeleted, onRetried }) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [copiedHash, setCopiedHash] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDownload = async () => {
    try {
      setIsDownloading(true);
      const { downloadUrl } = await api.getDownloadUrl(file.fileId);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = file.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err: any) {
      alert(`Download failed: ${err.message}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDelete = async () => {
    try {
      setIsDeleting(true);
      await api.deleteFile(file.fileId);
      onDeleted(file.fileId);
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleRetry = async () => {
    try {
      setIsRetrying(true);
      await api.retryUpload(file.fileId);
      onRetried();
    } catch (err: any) {
      alert(`Retry failed: ${err.message}`);
    } finally {
      setIsRetrying(false);
    }
  };

  const copyHash = () => {
    const h = file.contentHash || file.checksum;
    if (!h) return;
    navigator.clipboard.writeText(h);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  const hash = file.contentHash || file.checksum;

  return (
    <div className="glass-card rounded-xl p-4 flex flex-col justify-between gap-3">
      <div>
        {/* Top bar: File name, Status & Dedup Badges */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-800/80 border border-slate-700/50">
              {getFileIcon(file.contentType, file.fileName)}
            </div>
            <div className="overflow-hidden">
              <h4 className="truncate text-sm font-semibold text-slate-100" title={file.fileName}>
                {file.fileName}
              </h4>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                <span>{formatBytes(file.size)}</span>
                <span>•</span>
                <span>{formatDate(file.createdAt)}</span>
              </div>
            </div>
          </div>

          {/* Status Badge */}
          <div className="shrink-0">
            {file.status === 'COMPLETED' && (
              <Badge variant="success">Completed</Badge>
            )}
            {file.status === 'UPLOADING' && (
              <Badge variant="default" className="animate-pulse">Uploading</Badge>
            )}
            {file.status === 'COMPLETING' && (
              <Badge variant="warning">Verifying S3</Badge>
            )}
            {file.status === 'INITIATED' && (
              <Badge variant="secondary">Initiated</Badge>
            )}
            {file.status === 'FAILED' && (
              <Badge variant="destructive">Failed</Badge>
            )}
          </div>
        </div>

        {/* Deduplication & Checksum Info */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {file.isDedup ? (
            <Badge variant="dedup" className="gap-1">
              <Layers className="h-3 w-3" />
              <span>Dedup Alias</span>
            </Badge>
          ) : file.refCount && file.refCount > 1 ? (
            <Badge variant="canonical" className="gap-1">
              <Layers className="h-3 w-3" />
              <span>Canonical (refs: {file.refCount})</span>
            </Badge>
          ) : null}

          {hash && (
            <div
              onClick={copyHash}
              className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900/80 px-2 py-0.5 text-[11px] font-mono text-slate-300 hover:border-slate-700 cursor-pointer transition-colors"
              title="Click to copy SHA-256 digest"
            >
              <ShieldCheck className="h-3 w-3 text-emerald-400" />
              <span>{hash.slice(0, 8)}...{hash.slice(-6)}</span>
              {copiedHash ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3 text-slate-500 hover:text-slate-300" />
              )}
            </div>
          )}
        </div>

        {/* Failure Reason */}
        {file.status === 'FAILED' && file.failureReason && (
          <div className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-rose-900/40 bg-rose-950/30 p-2 text-[11px] text-rose-300">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{file.failureReason}</span>
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-between border-t border-slate-800/80 pt-3 mt-2">
        <div className="text-[11px] text-slate-400 truncate max-w-[180px]" title={file.s3Key}>
          s3://{file.s3Key}
        </div>

        <div className="flex items-center gap-1.5">
          {file.status === 'COMPLETED' && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              disabled={isDownloading}
              className="h-8 gap-1 text-xs"
            >
              {isDownloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5 text-indigo-400" />
              )}
              Download
            </Button>
          )}

          {file.status === 'FAILED' && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              disabled={isRetrying}
              className="h-8 gap-1 text-xs text-amber-300 border-amber-800/40 hover:bg-amber-950/50"
            >
              {isRetrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              Retry
            </Button>
          )}

          {showDeleteConfirm ? (
            <div className="flex items-center gap-1">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={isDeleting}
                className="h-8 text-xs px-2"
              >
                Confirm
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(false)}
                className="h-8 text-xs px-2 text-slate-400"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowDeleteConfirm(true)}
              className="h-8 w-8 text-slate-400 hover:text-rose-400"
              title="Delete file"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
