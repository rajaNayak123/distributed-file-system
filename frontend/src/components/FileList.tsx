import React, { useState, useMemo } from 'react';
import type { FileItem } from '@/api/client';
import { FileCard } from './FileCard';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Search, FolderOpen, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FileListProps {
  files: FileItem[];
  onDeleted: (fileId: string) => void;
  onRetried: () => void;
  onOpenUpload: () => void;
}

export const FileList: React.FC<FileListProps> = ({
  files,
  onDeleted,
  onRetried,
  onOpenUpload,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'completed' | 'pending'>('all');

  const filteredFiles = useMemo(() => {
    return files.filter((file) => {
      // Tab filter
      if (activeTab === 'completed' && file.status !== 'COMPLETED') return false;
      if (activeTab === 'pending' && file.status === 'COMPLETED') return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          file.fileName.toLowerCase().includes(q) ||
          file.contentType.toLowerCase().includes(q) ||
          (file.checksum && file.checksum.toLowerCase().includes(q))
        );
      }

      return true;
    });
  }, [files, activeTab, searchQuery]);

  return (
    <div className="space-y-4">
      {/* Search & Tabs Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as any)}
          className="w-full sm:w-auto"
        >
          <TabsList className="grid w-full grid-cols-3 sm:w-auto">
            <TabsTrigger value="all">
              All ({files.length})
            </TabsTrigger>
            <TabsTrigger value="completed">
              Completed ({files.filter((f) => f.status === 'COMPLETED').length})
            </TabsTrigger>
            <TabsTrigger value="pending">
              In-Flight / Failed ({files.filter((f) => f.status !== 'COMPLETED').length})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Search input */}
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input
            placeholder="Search by name, type, or hash..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9 text-xs"
          />
        </div>
      </div>

      {/* Grid or Empty State */}
      {filteredFiles.length === 0 ? (
        <div className="glass-panel flex flex-col items-center justify-center rounded-2xl p-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-400 mb-3">
            <FolderOpen className="h-7 w-7" />
          </div>
          <h3 className="text-base font-semibold text-slate-200">No files found</h3>
          <p className="mt-1 text-xs text-slate-400 max-w-sm">
            {searchQuery
              ? `No files match your search "${searchQuery}". Try clearing the search filter.`
              : activeTab === 'completed'
              ? 'No completed files found. Upload a file to see it here.'
              : activeTab === 'pending'
              ? 'No in-progress or failed uploads.'
              : 'You haven’t uploaded any files yet. Upload a file directly to S3!'}
          </p>

          {!searchQuery && (
            <Button
              size="sm"
              onClick={onOpenUpload}
              className="mt-4 gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              <UploadCloud className="h-4 w-4" />
              Upload First File
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredFiles.map((file) => (
            <FileCard
              key={file.fileId}
              file={file}
              onDeleted={onDeleted}
              onRetried={onRetried}
            />
          ))}
        </div>
      )}
    </div>
  );
};
