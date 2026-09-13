/**
 * Typed API Client for Distributed File Storage backend
 */

export interface User {
  userId: string;
  email: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface FileItem {
  fileId: string;
  userId: string;
  fileName: string;
  size: number;
  contentType: string;
  status: 'INITIATED' | 'UPLOADING' | 'COMPLETING' | 'COMPLETED' | 'FAILED';
  s3Key: string;
  etag?: string;
  checksum?: string | null;
  contentHash?: string | null;
  isDedup?: boolean;
  canonicalFileId?: string | null;
  canonicalUserId?: string | null;
  refCount?: number;
  failureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InitiateUploadResponse {
  uploadId: string;
  fileId: string;
  presignedUrl?: string;
  expiresAt?: string;
  multipartRequired?: boolean;
}

export interface MultipartPartUrl {
  partNumber: number;
  url: string;
}

export interface ClusterHealth {
  status: string;
  instance?: string;
  checks?: {
    dynamo?: string;
    s3?: string;
  };
}

export interface RateLimitState {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

/**
 * Normalizes S3 presigned URLs generated inside Docker (where hostname is 'localstack:4566')
 * to 'localhost:4566' so the host machine's browser can directly connect.
 */
export function normalizeS3Url(url: string): string {
  if (!url) return url;
  return url.replace('http://localstack:4566', 'http://localhost:4566');
}

// In-memory rate limit listener
let rateLimitListener: ((state: RateLimitState) => void) | null = null;
export function setRateLimitListener(cb: (state: RateLimitState) => void) {
  rateLimitListener = cb;
}

class ApiClient {
  private getAccessToken(): string | null {
    return localStorage.getItem('dfs_access_token');
  }

  private getRefreshToken(): string | null {
    return localStorage.getItem('dfs_refresh_token');
  }

  public setTokens(access: string, refresh: string, user: User) {
    localStorage.setItem('dfs_access_token', access);
    localStorage.setItem('dfs_refresh_token', refresh);
    localStorage.setItem('dfs_user', JSON.stringify(user));
  }

  public clearTokens() {
    localStorage.removeItem('dfs_access_token');
    localStorage.removeItem('dfs_refresh_token');
    localStorage.removeItem('dfs_user');
  }

  public getUser(): User | null {
    const raw = localStorage.getItem('dfs_user');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const token = this.getAccessToken();
    const headers = new Headers(options.headers || {});
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }

    let response = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers,
    });

    // Extract rate limit headers if present
    const limitHeader = response.headers.get('X-RateLimit-Limit');
    const remHeader = response.headers.get('X-RateLimit-Remaining');
    const resetHeader = response.headers.get('X-RateLimit-Reset');
    const retryAfterHeader = response.headers.get('Retry-After');

    if (limitHeader && rateLimitListener) {
      rateLimitListener({
        limit: parseInt(limitHeader, 10),
        remaining: remHeader ? parseInt(remHeader, 10) : 0,
        reset: resetHeader ? parseInt(resetHeader, 10) : 0,
        retryAfter: retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined,
      });
    }

    // Auto-refresh token if 401
    if (response.status === 401 && this.getRefreshToken()) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        headers.set('Authorization', `Bearer ${this.getAccessToken()}`);
        response = await fetch(`${API_BASE}${url}`, {
          ...options,
          headers,
        });
      }
    }

    return response;
  }

  private async parseJson<T>(res: Response): Promise<T> {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMessage =
        data.error?.message ||
        data.message ||
        data.error ||
        `Request failed with status ${res.status}`;
      throw new Error(errMessage);
    }
    return data as T;
  }

  // --- Auth ---
  public async register(payload: { email: string; password: string }): Promise<AuthResponse> {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await this.parseJson<AuthResponse>(res);
    this.setTokens(data.accessToken, data.refreshToken, data.user);
    return data;
  }

  public async login(payload: { email: string; password: string }): Promise<AuthResponse> {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await this.parseJson<AuthResponse>(res);
    this.setTokens(data.accessToken, data.refreshToken, data.user);
    return data;
  }

  public async refreshToken(): Promise<boolean> {
    const rToken = this.getRefreshToken();
    if (!rToken) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rToken }),
      });
      if (!res.ok) {
        this.clearTokens();
        return false;
      }
      const data = await res.json();
      this.setTokens(data.accessToken, data.refreshToken, data.user);
      return true;
    } catch {
      this.clearTokens();
      return false;
    }
  }

  // --- Files ---
  public async listFiles(includeIncomplete = true): Promise<{ files: FileItem[] }> {
    const res = await this.fetchWithAuth(`/files?includeIncomplete=${includeIncomplete}`);
    return this.parseJson(res);
  }

  public async getFile(fileId: string): Promise<{ file: FileItem }> {
    const res = await this.fetchWithAuth(`/files/${fileId}?includeIncomplete=true`);
    return this.parseJson(res);
  }

  public async getDownloadUrl(fileId: string): Promise<{ downloadUrl: string; expiresAt: string }> {
    const res = await this.fetchWithAuth(`/files/${fileId}/download`);
    const data = await this.parseJson<{ downloadUrl: string; expiresAt: string }>(res);
    return {
      downloadUrl: normalizeS3Url(data.downloadUrl),
      expiresAt: data.expiresAt,
    };
  }

  public async deleteFile(fileId: string): Promise<{ deleted: boolean; s3Deleted?: boolean }> {
    const res = await this.fetchWithAuth(`/files/${fileId}`, { method: 'DELETE' });
    return this.parseJson(res);
  }

  public async retryUpload(fileId: string): Promise<{
    fileId: string;
    uploadType: 'single' | 'multipart';
    presignedUrl?: string;
    s3UploadId?: string;
  }> {
    const res = await this.fetchWithAuth(`/files/${fileId}/retry`, { method: 'POST' });
    const data = await this.parseJson<{
      fileId: string;
      uploadType: 'single' | 'multipart';
      presignedUrl?: string;
      s3UploadId?: string;
    }>(res);
    return {
      ...data,
      presignedUrl: data.presignedUrl ? normalizeS3Url(data.presignedUrl) : undefined,
    };
  }

  // --- Uploads ---
  public async initiateUpload(payload: {
    fileName: string;
    contentType: string;
    size: number;
    idempotencyKey?: string;
  }): Promise<InitiateUploadResponse> {
    const headers: Record<string, string> = {};
    if (payload.idempotencyKey) {
      headers['Idempotency-Key'] = payload.idempotencyKey;
    }

    const res = await this.fetchWithAuth('/uploads', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fileName: payload.fileName,
        contentType: payload.contentType,
        size: payload.size,
      }),
    });

    const data = await this.parseJson<InitiateUploadResponse>(res);
    return {
      ...data,
      presignedUrl: data.presignedUrl ? normalizeS3Url(data.presignedUrl) : undefined,
    };
  }

  public async completeUpload(fileId: string, idempotencyKey?: string): Promise<FileItem> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    const res = await this.fetchWithAuth(`/uploads/${fileId}/complete`, {
      method: 'POST',
      headers,
    });
    return this.parseJson<FileItem>(res);
  }

  // --- Multipart ---
  public async initiateMultipart(fileId: string): Promise<{ fileId: string; s3UploadId: string }> {
    const res = await this.fetchWithAuth(`/uploads/${fileId}/multipart/initiate`, {
      method: 'POST',
    });
    return this.parseJson(res);
  }

  public async getMultipartParts(
    fileId: string,
    partNumbers: number[]
  ): Promise<{ presignedUrls: MultipartPartUrl[] }> {
    const res = await this.fetchWithAuth(`/uploads/${fileId}/multipart/parts`, {
      method: 'POST',
      body: JSON.stringify({ partNumbers }),
    });
    const data = await this.parseJson<{ presignedUrls: MultipartPartUrl[] }>(res);
    return {
      presignedUrls: data.presignedUrls.map((p) => ({
        partNumber: p.partNumber,
        url: normalizeS3Url(p.url),
      })),
    };
  }

  public async completeMultipart(
    fileId: string,
    parts: { partNumber: number; eTag: string }[]
  ): Promise<FileItem> {
    const res = await this.fetchWithAuth(`/uploads/${fileId}/multipart/complete`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    });
    return this.parseJson<FileItem>(res);
  }

  public async abortMultipart(fileId: string): Promise<{ fileId: string; status: string }> {
    const res = await this.fetchWithAuth(`/uploads/${fileId}/multipart/abort`, {
      method: 'POST',
    });
    return this.parseJson(res);
  }

  // --- Health ---
  public async checkHealth(): Promise<ClusterHealth> {
    const res = await fetch(`${API_BASE}/ready`).catch(() => null);
    if (!res) {
      return { status: 'offline' };
    }
    return res.json().catch(() => ({ status: 'unavailable' }));
  }
}

export const api = new ApiClient();
