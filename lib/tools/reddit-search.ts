import { tool } from 'ai';
import { z } from 'zod';
import { UIMessageStreamWriter } from 'ai';
import { ChatMessage } from '@/lib/types';
import { tavily } from '@tavily/core';
import { serverEnv } from '@/env/server';

export function redditSearchTool(dataStream?: UIMessageStreamWriter<ChatMessage>) {
  return tool({
    description: 'Search Reddit content using Tavily API with Reddit domain filtering.',
    inputSchema: z.object({
      queries: z
        .array(z.string().max(200))
        .describe('Array of search queries to execute on Reddit. Minimum 1, recommended 3-5.')
        .min(1)
        .max(5),
      maxResults: z.array(z.number()).optional().describe('Array of maximum results per query. Default is 20 per query.'),
      timeRange: z
        .array(z.enum(['day', 'week', 'month', 'year']))
        .optional()
        .describe('Deprecated: no longer used, kept for backward compatibility.'),
    }),
    execute: async ({
      queries,
      maxResults,
      timeRange,
    }: {
      queries: string[];
      maxResults?: number[];
      timeRange?: ('day' | 'week' | 'month' | 'year')[];
    }) => {
      console.log('Reddit search queries:', queries);
      console.log('Max results:', maxResults);
      console.log('Time ranges (deprecated):', timeRange);

      const tvly = tavily({ apiKey: serverEnv.TAVILY_API_KEY });

      const searchPromises = queries.map(async (query, index) => {
        const currentMaxResults = maxResults?.[index] || maxResults?.[0] || 20;

        try {
          // Send start notification
          dataStream?.write({
            type: 'data-query_completion',
            data: {
              query,
              index,
              total: queries.length,
              status: 'started',
              resultsCount: 0,
              imagesCount: 0,
            },
          });

          const data = await tvly.search(query, {
            maxResults: currentMaxResults,
            includeDomains: ['reddit.com'],
            searchDepth: 'basic',
            includeAnswer: false,
          });

          const processedResults = data.results.map((result) => {
            const subredditMatch = result.url.match(/reddit\.com\/r\/([^/]+)/i);
            const subreddit = subredditMatch ? subredditMatch[1] : 'unknown';
            const isRedditPost = /reddit\.com\/r\/[^/]+\/comments\//i.test(result.url);

            return {
              url: result.url,
              title: result.title || result.url,
              content: result.content || '',
              published_date: result.publishedDate,
              subreddit,
              isRedditPost,
              score: result.score,
            };
          });

          const resultsCount = processedResults.length;

          // Send completion notification
          dataStream?.write({
            type: 'data-query_completion',
            data: {
              query,
              index,
              total: queries.length,
              status: 'completed',
              resultsCount: resultsCount,
              imagesCount: 0,
            },
          });

          return {
            query,
            results: processedResults,
          };
        } catch (error) {
          console.error(`Reddit search error for query "${query}":`, error);

          // Send error notification
          dataStream?.write({
            type: 'data-query_completion',
            data: {
              query,
              index,
              total: queries.length,
              status: 'error',
              resultsCount: 0,
              imagesCount: 0,
            },
          });

          return {
            query,
            results: [],
          };
        }
      });

      const searches = await Promise.all(searchPromises);

      return {
        searches,
      };
    },
  });
}
