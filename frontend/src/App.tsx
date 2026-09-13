import React, { useState, useEffect, useCallback } from 'react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { api, type FileItem } from '@/api/client';
import { Navbar } from '@/components/Navbar';
import { MetricsBar } from '@/components/MetricsBar';
import { FileList } from '@/components/FileList';
import { UploadModal } from '@/components/UploadModal';
import { AuthModal } from '@/components/AuthModal';
import { RateLimitBanner } from '@/components/RateLimitBanner';
import { Button } from '@/components/ui/button';
import {
  Cloud,
  Shield,
  Zap,
  HardDrive,
  Copy,
  Layers,
  ArrowRight,
  Server,
  Activity,
} from 'lucide-react';

const MainDashboard: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  const fetchFiles = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setIsLoadingFiles(true);
      const res = await api.listFiles(true);
      setFiles(res.files || []);
    } catch (err) {
      console.error('Failed to load files', err);
    } finally {
      setIsLoadingFiles(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchFiles();
    } else {
      setFiles([]);
    }
  }, [isAuthenticated, fetchFiles]);

  const handleFileDeleted = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.fileId !== fileId));
  };

  return (
    <div className="min-h-screen bg-[#080c15] text-slate-100 flex flex-col">
      <Navbar
        onOpenUpload={() => (isAuthenticated ? setIsUploadOpen(true) : setIsAuthOpen(true))}
        onOpenAuth={() => setIsAuthOpen(true)}
        onRefresh={fetchFiles}
        isRefreshing={isLoadingFiles}
      />

      <main className="container mx-auto flex-1 max-w-7xl px-4 py-6 sm:px-6 space-y-6">
        <RateLimitBanner />

        {isAuthenticated ? (
          <>
            {/* Storage Metrics */}
            <MetricsBar files={files} />

            {/* File List / Explorer */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-white tracking-tight">Your Storage</h2>
                  <p className="text-xs text-slate-400">
                    Stateless API metadata synchronized with Amazon S3 & DynamoDB
                  </p>
                </div>
              </div>

              <FileList
                files={files}
                onDeleted={handleFileDeleted}
                onRetried={fetchFiles}
                onOpenUpload={() => setIsUploadOpen(true)}
              />
            </div>
          </>
        ) : (
          /* Landing Hero for Unauthenticated Visitors */
          <div className="flex flex-col items-center justify-center py-12 text-center space-y-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3.5 py-1 text-xs font-medium text-indigo-400">
              <Activity className="h-3.5 w-3.5" />
              <span>Production-Style Distributed File Storage</span>
            </div>

            <div className="max-w-3xl space-y-4">
              <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-6xl bg-gradient-to-b from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
                Mini Dropbox And <br />
                Google Drive
              </h1>
              <p className="text-base text-slate-400 sm:text-lg max-w-2xl mx-auto">
                Engineered from the ground up for high concurrency: zero file bytes on API disk, direct S3 presigned transfers, SQS event-driven workers, and automatic storage deduplication.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button
                size="lg"
                onClick={() => setIsAuthOpen(true)}
                className="gap-2 bg-indigo-600 hover:bg-indigo-500 text-white shadow-xl shadow-indigo-600/30 font-semibold"
              >
                <span>Get Started</span>
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>

            {/* Architecture Highlights Grid */}
            <div className="grid grid-cols-1 gap-4 pt-8 sm:grid-cols-2 lg:grid-cols-3 max-w-5xl text-left">
              <div className="glass-card rounded-2xl p-5 space-y-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400">
                  <Zap className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-white text-sm">Direct Presigned S3 Transfers</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Files bypass API servers entirely. The browser streams bytes directly to S3 via short-lived presigned URLs with verified HeadObject completion.
                </p>
              </div>

              <div className="glass-card rounded-2xl p-5 space-y-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400">
                  <Copy className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-white text-sm">Content-Addressed Deduplication</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Identical files uploaded by any user are detected via SHA-256 ContentHashIndex GSI, referencing a canonical object and deleting duplicate bytes.
                </p>
              </div>

              <div className="glass-card rounded-2xl p-5 space-y-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
                  <Layers className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-white text-sm">Resumable Multipart Uploads</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Files above 50MB are chunked and uploaded in parallel with per-part retry, ETag verification, and automatic abandoned-upload cleanup.
                </p>
              </div>

              <div className="glass-card rounded-2xl p-5 space-y-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400">
                  <Server className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-white text-sm">Stateless API & Load Balancing</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Multiple API replicas run behind an Nginx load balancer with health-based failover. Any replica can serve any request without state loss.
                </p>
              </div>

              <div className="glass-card rounded-2xl p-5 space-y-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
                  <HardDrive className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-white text-sm">Two-Way Reconciliation Loop</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Worker processes periodically close the S3/DynamoDB consistency gap: marking missing objects as FAILED and sweeping orphaned S3 storage.
                </p>
              </div>

              <div className="glass-card rounded-2xl p-5 space-y-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-pink-500/10 text-pink-400">
                  <Shield className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-white text-sm">Shared Redis Rate Limiting</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Distributed atomic counters prevent clients from bypassing rate limits across multiple stateless backend instances.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Upload Dialog */}
      <UploadModal
        open={isUploadOpen}
        onOpenChange={setIsUploadOpen}
        onUploadSuccess={fetchFiles}
      />

      {/* Auth Dialog */}
      <AuthModal
        open={isAuthOpen}
        onOpenChange={setIsAuthOpen}
      />

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950/60 py-6 text-center text-xs text-slate-500">
        <div className="container mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3 max-w-7xl">
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-indigo-400" />
            <span className="font-medium text-slate-400">DFS Drive</span>
          </div>
          <div className="flex items-center gap-4 text-slate-500">
            <span>&copy; {new Date().getFullYear()} DFS Drive. All rights reserved.</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <MainDashboard />
    </AuthProvider>
  );
}
