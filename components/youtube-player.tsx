'use client';

import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface YouTubePlayerProps {
  videoId: string;
  startTime?: number;
  autoplay?: boolean;
  className?: string;
}

export const YouTubePlayer: React.FC<YouTubePlayerProps> = ({
  videoId,
  startTime = 0,
  autoplay = false,
  className = '',
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [key, setKey] = useState(0);

  // Update key when startTime changes to force iframe reload
  React.useEffect(() => {
    setKey((prev) => prev + 1);
    setIsLoaded(false);
  }, [startTime]);

  // Build YouTube embed URL with privacy-enhanced mode
  const getEmbedUrl = () => {
    const params = new URLSearchParams({
      enablejsapi: '1',
      origin: typeof window !== 'undefined' ? window.location.origin : '',
      ...(startTime > 0 && { start: startTime.toString(), autoplay: '1' }),
      ...(autoplay && { autoplay: '1' }),
    });

    return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
  };

  const getYouTubeUrl = () => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    return startTime > 0 ? `${url}&t=${startTime}` : url;
  };

  return (
    <div className={`relative w-full ${className}`}>
      {/* 16:9 Aspect Ratio Container */}
      <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
        {/* Loading State */}
        {!isLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 dark:bg-neutral-800 rounded-lg">
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-neutral-300 border-t-red-500" />
              <span className="text-sm text-neutral-500">Loading video...</span>
            </div>
          </div>
        )}

        {/* YouTube iframe */}
        <iframe
          key={key}
          src={getEmbedUrl()}
          title={`YouTube video player - ${videoId}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          onLoad={() => setIsLoaded(true)}
          className={`absolute inset-0 w-full h-full rounded-lg border-0 ${
            isLoaded ? 'opacity-100' : 'opacity-0'
          } transition-opacity duration-300`}
        />
      </div>

      {/* Quick Actions Overlay */}
      <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="secondary"
          size="sm"
          className="h-8 px-2 bg-black/70 hover:bg-black/90 text-white border-0"
          onClick={() => window.open(getYouTubeUrl(), '_blank')}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="sr-only">Open in YouTube</span>
        </Button>
      </div>
    </div>
  );
};

// Compact mini player for inline embedding
interface YouTubeMiniPlayerProps {
  videoId: string;
  startTime?: number;
  onClose?: () => void;
}

export const YouTubeMiniPlayer: React.FC<YouTubeMiniPlayerProps> = ({ videoId, startTime, onClose }) => {
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 shadow-2xl rounded-lg overflow-hidden group">
      <YouTubePlayer videoId={videoId} startTime={startTime} autoplay={false} />
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-2 left-2 flex items-center justify-center h-8 w-8 rounded-full bg-black/70 hover:bg-black/90 text-white opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Close mini player"
        >
          ×
        </button>
      )}
    </div>
  );
};
