import React, { useState, useEffect } from 'react';
import { setRateLimitListener, type RateLimitState } from '@/api/client';
import { AlertCircle, Zap } from 'lucide-react';

export const RateLimitBanner: React.FC = () => {
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    setRateLimitListener((state) => {
      setRateLimit(state);
      if (state.retryAfter && state.retryAfter > 0) {
        setCountdown(state.retryAfter);
      }
    });
  }, []);

  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) return null;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  if (!rateLimit) return null;

  // Show banner only if remaining <= 5 or 429
  const isLimited = countdown !== null && countdown > 0;
  const isNearLimit = rateLimit.remaining <= 5;

  if (!isLimited && !isNearLimit) return null;

  return (
    <div
      className={`flex items-center justify-between rounded-xl px-4 py-2.5 text-xs transition-all ${
        isLimited
          ? 'border border-rose-800/60 bg-rose-950/80 text-rose-200'
          : 'border border-amber-800/40 bg-amber-950/60 text-amber-200'
      }`}
    >
      <div className="flex items-center gap-2">
        {isLimited ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
        ) : (
          <Zap className="h-4 w-4 shrink-0 text-amber-400" />
        )}
        <span>
          {isLimited ? (
            <>
              <strong>Rate limit reached.</strong> Shared Redis quota active. Please wait{' '}
              <span className="font-mono font-bold text-white">{countdown}s</span> before retrying.
            </>
          ) : (
            <>
              <strong>Quota Alert:</strong> {rateLimit.remaining} of {rateLimit.limit} requests
              remaining in the current rate limit window.
            </>
          )}
        </span>
      </div>

      <div className="text-[11px] font-mono text-slate-400">
        Window Reset: {new Date(rateLimit.reset * 1000).toLocaleTimeString()}
      </div>
    </div>
  );
};
