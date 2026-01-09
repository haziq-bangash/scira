import Exa from 'exa-js';
import { tool } from 'ai';
import { z } from 'zod';
import { serverEnv } from '@/env/server';
import { getSubtitles, getVideoDetails } from 'youtube-caption-extractor';

interface VideoDetails {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  type?: string;
  provider_name?: string;
  provider_url?: string;
  author_avatar_url?: string;
}

interface VideoStats {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

interface VideoResult {
  videoId: string;
  url: string;
  details?: VideoDetails;
  captions?: string;
  timestamps?: string[];
  views?: number | string;
  likes?: number | string;
  summary?: string;
  publishedDate?: string;
  durationSeconds?: number;
  stats?: VideoStats;
  tags?: string[];
}

interface SubtitleFragment {
  start: string; // seconds as string from API
  dur: string; // seconds as string from API
  text: string;
}

type TimeRange = 'day' | 'week' | 'month' | 'year' | 'anytime';

const BATCH_SIZE = 4;
const SEARCH_LIMIT = 12;
const YOUTUBE_BASE_URL = 'https://www.youtube.com/watch?v=';
const YOUTUBE_VIDEO_ID_REGEX = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;

const chapterRegex = /^\s*((?:\d+:)?\d{1,2}:\d{2})\s*[-–—]?\s*(.+)$/i;

// Helper to extract video ID from YouTube URL
function extractVideoId(url: string): string | null {
  const match = url.match(YOUTUBE_VIDEO_ID_REGEX);
  return match ? match[1] : null;
}

// Helper to convert TimeRange to date for Exa filtering
function getStartDateFromTimeRange(timeRange: TimeRange): string | undefined {
  if (timeRange === 'anytime') return undefined;
  
  const now = new Date();
  let daysAgo: number;
  
  switch (timeRange) {
    case 'day':
      daysAgo = 1;
      break;
    case 'week':
      daysAgo = 7;
      break;
    case 'month':
      daysAgo = 30;
      break;
    case 'year':
      daysAgo = 365;
      break;
    default:
      return undefined;
  }
  
  const startDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return startDate.toISOString();
}

// Fetch video metadata from YouTube Data API (optional enhancement)
async function fetchYouTubeMetadata(videoId: string): Promise<{
  viewCount?: number;
  likeCount?: number;
  channelTitle?: string;
  channelId?: string;
  publishedAt?: string;
  tags?: string[];
} | null> {
  if (!serverEnv.YOUTUBE_API_KEY) return null;
  
  try {
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoId}&key=${serverEnv.YOUTUBE_API_KEY}`
    );
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const video = data.items?.[0];
    
    if (!video) return null;
    
    return {
      viewCount: parseInt(video.statistics?.viewCount || '0', 10),
      likeCount: parseInt(video.statistics?.likeCount || '0', 10),
      channelTitle: video.snippet?.channelTitle,
      channelId: video.snippet?.channelId,
      publishedAt: video.snippet?.publishedAt,
      tags: video.snippet?.tags,
    };
  } catch (error) {
    console.warn(`⚠️ YouTube API metadata fetch failed for ${videoId}:`, error);
    return null;
  }
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function dedupeVideos(videoIds: string[]): string[] {
  return Array.from(new Set(videoIds));
}

function extractChaptersFromDescription(description?: string): string[] | undefined {
  if (!description) return undefined;
  const chapters: string[] = [];
  const lines = description.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(chapterRegex);
    if (match) {
      const [, time, title] = match;
      if (time && title) {
        chapters.push(`${time} - ${title.trim()}`);
      }
    }
  }
  return chapters.length > 0 ? chapters : undefined;
}

function generateChaptersFromSubtitles(
  subs: SubtitleFragment[] | undefined,
  targetCount: number = 30,
): string[] | undefined {
  if (!subs || subs.length === 0) return undefined;

  const parseSeconds = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };

  const last = subs[subs.length - 1];
  const totalDurationSec = Math.max(0, parseSeconds(last.start) + parseSeconds(last.dur));
  if (totalDurationSec <= 1) return undefined;

  const interval = Math.max(10, Math.floor(totalDurationSec / targetCount));

  const formatTime = (secondsTotal: number) => {
    const seconds = Math.max(1, Math.floor(secondsTotal)); // avoid 0:00 which UI filters out
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };

  const chapters: string[] = [];
  const usedTimes = new Set<number>();
  for (let t = interval; t < totalDurationSec; t += interval) {
    const idx = subs.findIndex((sf) => parseSeconds(sf.start) >= t);
    const chosen = idx >= 0 ? subs[idx] : subs[subs.length - 1];
    const text = chosen.text?.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = Math.floor(parseSeconds(chosen.start));
    if (usedTimes.has(key)) continue;
    usedTimes.add(key);
    chapters.push(`${formatTime(key)} - ${text}`);
    if (chapters.length >= targetCount) break;
  }

  return chapters.length > 0 ? chapters : undefined;
}

async function buildTranscriptArtifacts(videoId: string, fallbackDescription?: string) {
  const details = await getVideoDetails({ videoID: videoId, lang: 'en' }).catch((error: unknown) => {
    console.warn(`⚠️ getVideoDetails failed for ${videoId}:`, error);
    return null;
  });

  let subtitleSource: SubtitleFragment[] | undefined =
    Array.isArray(details?.subtitles) && details!.subtitles.length > 0
      ? (details!.subtitles as SubtitleFragment[])
      : undefined;

  if (!subtitleSource) {
    subtitleSource = (await getSubtitles({ videoID: videoId, lang: 'en' }).catch((error: unknown) => {
      console.warn(`⚠️ getSubtitles failed for ${videoId}:`, error);
      return null;
    })) as SubtitleFragment[] | undefined;
  }

  const transcriptText = subtitleSource?.map((s) => s.text).join('\n');

  const timestampsFromDescription = extractChaptersFromDescription(details?.description ?? fallbackDescription);
  const timestamps = timestampsFromDescription ?? generateChaptersFromSubtitles(subtitleSource);

  return {
    transcriptText,
    timestamps,
    description: details?.description ?? fallbackDescription,
    subtitles: subtitleSource,
  };
}

// Search YouTube videos using Exa
async function searchYouTubeVideos(query: string, timeRange: TimeRange): Promise<string[]> {
  try {
    const exa = new Exa(serverEnv.EXA_API_KEY);
    
    // Add "video" to query for better targeting
    const enhancedQuery = `${query} video`;
    
    const searchOptions: any = {
      numResults: SEARCH_LIMIT * 2, // Request more to account for filtering
      includeDomains: ['youtube.com', 'youtu.be'],
      useAutoprompt: false,
    };
    
    // Add date filtering if not anytime
    const startDate = getStartDateFromTimeRange(timeRange);
    if (startDate) {
      searchOptions.startPublishedDate = startDate;
    }
    
    console.log('🔎 Exa YouTube search', { query, timeRange, enhancedQuery, searchOptions });
    
    const results = await exa.searchAndContents(enhancedQuery, searchOptions);
    
    if (!results?.results || results.results.length === 0) {
      console.log('ℹ️ Exa returned no results for YouTube search');
      return [];
    }
    
    // Extract video IDs from URLs
    const videoIds: string[] = [];
    for (const result of results.results) {
      if (result.url) {
        const videoId = extractVideoId(result.url);
        if (videoId) {
          videoIds.push(videoId);
        }
      }
    }
    
    // Deduplicate and limit
    const uniqueIds = dedupeVideos(videoIds).slice(0, SEARCH_LIMIT);
    
    console.log(`🎥 Extracted ${uniqueIds.length} unique video IDs from Exa results`);
    
    return uniqueIds;
  } catch (error) {
    console.error('❌ Exa YouTube search failed:', error);
    return [];
  }
}

export const youtubeSearchTool = tool({
  description: 'Search YouTube videos using Exa and enrich them with transcripts, chapters, and metadata. Optionally fetches view counts and stats from YouTube Data API if available.',
  inputSchema: z.object({
    query: z.string().describe('The search query for YouTube videos'),
    timeRange: z.enum(['day', 'week', 'month', 'year', 'anytime']).default('anytime').describe('Time range filter for video uploads. Use "day" for last 24 hours, "week" for last 7 days, "month" for last 30 days, "year" for last 365 days, or "anytime" for all time. Default is "anytime".'),
  }),
  execute: async ({ query, timeRange = 'anytime' }: { query: string; timeRange?: TimeRange }) => {
    try {
      // Search for YouTube videos using Exa
      const videoIds = await searchYouTubeVideos(query, timeRange);

      if (videoIds.length === 0) {
        console.log('ℹ️ No video IDs found for the provided query');
        return { results: [] };
      }

      console.log(`🎥 Processing ${videoIds.length} video IDs`);

      const batches = chunkArray(videoIds, BATCH_SIZE);
      const processedResults: VideoResult[] = [];

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        try {
          const batchResults = await Promise.allSettled(
            batch.map(async (videoId): Promise<VideoResult | null> => {
              const videoUrl = `${YOUTUBE_BASE_URL}${videoId}`;

              const baseResult: VideoResult = {
                videoId,
                url: videoUrl,
              };

              try {
                // Fetch transcripts and YouTube API metadata in parallel
                const [transcripts, youtubeApiData] = await Promise.all([
                  buildTranscriptArtifacts(videoId),
                  fetchYouTubeMetadata(videoId),
                ]);

                const stats: VideoStats | undefined = youtubeApiData
                  ? {
                      views: youtubeApiData.viewCount,
                      likes: youtubeApiData.likeCount,
                    }
                  : undefined;

                const processedVideo: VideoResult = {
                  ...baseResult,
                  details: {
                    title: transcripts.description?.split('\n')[0] || 'YouTube Video',
                    author_name: youtubeApiData?.channelTitle,
                    author_url: youtubeApiData?.channelId
                      ? `https://www.youtube.com/channel/${youtubeApiData.channelId}`
                      : undefined,
                    thumbnail_url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                    provider_name: 'YouTube',
                    provider_url: 'https://www.youtube.com',
                  },
                  captions: transcripts.transcriptText,
                  timestamps: transcripts.timestamps,
                  summary: transcripts.description,
                  publishedDate: youtubeApiData?.publishedAt,
                  stats,
                  tags: youtubeApiData?.tags,
                };

                if (processedVideo.stats?.views != null) {
                  processedVideo.views = processedVideo.stats.views;
                }
                if (processedVideo.stats?.likes != null) {
                  processedVideo.likes = processedVideo.stats.likes;
                }

                return processedVideo;
              } catch (error) {
                console.warn(`⚠️ Error processing video ${videoId}:`, error);
                return baseResult;
              }
            }),
          );

          const validBatchResults = batchResults
            .filter((result) => result.status === 'fulfilled' && result.value !== null)
            .map((result) => (result as PromiseFulfilledResult<VideoResult>).value);

          processedResults.push(...validBatchResults);
        } catch (batchError) {
          console.error(`💥 Batch ${batchIndex + 1} failed:`, batchError);
        }
      }

      console.log(`🏁 YouTube search completed with ${processedResults.length} enriched videos`);

      return {
        results: processedResults,
      };
    } catch (error) {
      console.error('YouTube search error:', error);
      throw error;
    }
  },
});
