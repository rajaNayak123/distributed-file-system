import React from 'react';
import type { FileItem } from '@/api/client';
import { formatBytes } from '@/lib/utils';
import { HardDrive, Files, Copy, AlertTriangle } from 'lucide-react';

interface MetricsBarProps {
  files: FileItem[];
}

export const MetricsBar: React.FC<MetricsBarProps> = ({ files }) => {
  const completedFiles = files.filter((f) => f.status === 'COMPLETED');
  const incompleteFiles = files.filter((f) => f.status !== 'COMPLETED');

  // Total unique storage: sum of canonical completed file sizes
  const totalStorageBytes = completedFiles
    .filter((f) => !f.isDedup)
    .reduce((acc, f) => acc + (f.size || 0), 0);

  // Raw logical storage: sum of all completed files as users perceive it
  const logicalStorageBytes = completedFiles.reduce((acc, f) => acc + (f.size || 0), 0);

  // Storage saved via deduplication
  const dedupSavedBytes = Math.max(logicalStorageBytes - totalStorageBytes, 0);
  const dedupCount = completedFiles.filter((f) => f.isDedup || (f.refCount && f.refCount > 1)).length;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
      {/* Total Files */}
      <div className="glass-card rounded-xl p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">Total Files</span>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
            <Files className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 text-2xl font-bold text-white">{completedFiles.length}</div>
        <div className="mt-0.5 text-[11px] text-slate-400">Active storage items</div>
      </div>

      {/* S3 Storage Used */}
      <div className="glass-card rounded-xl p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">S3 Physical Storage</span>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <HardDrive className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 text-2xl font-bold text-white">{formatBytes(totalStorageBytes)}</div>
        <div className="mt-0.5 text-[11px] text-slate-400">Physical bytes in S3</div>
      </div>

      {/* Deduplication Savings */}
      <div className="glass-card rounded-xl p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">Dedup Storage Saved</span>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/10 text-purple-400">
            <Copy className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 text-2xl font-bold text-purple-300">
          {formatBytes(dedupSavedBytes)}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          {dedupCount > 0 ? `${dedupCount} dedup references` : 'Zero redundant copies'}
        </div>
      </div>

      {/* Incomplete / In-Flight */}
      <div className="glass-card rounded-xl p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-400">Pending / Failed</span>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
            <AlertTriangle className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-2 text-2xl font-bold text-amber-300">
          {incompleteFiles.length}
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          {incompleteFiles.length > 0 ? 'Retryable upload sessions' : 'All uploads completed'}
        </div>
      </div>
    </div>
  );
};
