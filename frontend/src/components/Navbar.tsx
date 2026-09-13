import React from 'react';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Cloud, LogOut, User as UserIcon, LogIn, UploadCloud, RefreshCw } from 'lucide-react';

interface NavbarProps {
  onOpenUpload: () => void;
  onOpenAuth: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  onOpenUpload,
  onOpenAuth,
  onRefresh,
  isRefreshing = false,
}) => {
  const { user, isAuthenticated, logout } = useAuth();

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
      <div className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 text-white shadow-lg shadow-indigo-600/30">
            <Cloud className="h-5 w-5" />
          </div>
          <div>
            <span className="font-bold tracking-tight text-white sm:text-base">
              DFS Drive
            </span>
          </div>
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-2.5">
          {isAuthenticated ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isRefreshing}
                className="hidden sm:inline-flex"
                title="Refresh File List"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>

              <Button
                onClick={onOpenUpload}
                size="sm"
                className="gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/25"
              >
                <UploadCloud className="h-4 w-4" />
                <span className="hidden sm:inline">Upload</span>
              </Button>

              <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1 text-xs text-slate-300">
                <UserIcon className="h-3.5 w-3.5 text-indigo-400" />
                <span className="max-w-[130px] truncate">{user?.email}</span>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={logout}
                className="text-slate-400 hover:text-rose-400"
                title="Sign Out"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              onClick={onOpenAuth}
              size="sm"
              className="gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              <LogIn className="h-4 w-4" />
              Sign In
            </Button>
          )}
        </div>
      </div>
    </header>
  );
};
