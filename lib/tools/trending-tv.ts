import { tool } from 'ai';
import { z } from 'zod';

export const trendingTvTool = tool({
  description: 'Get popular and recently updated TV shows',
  inputSchema: z.object({}),
  execute: async () => {
    try {
      // Fetch shows with recent updates (indicates popularity/activity)
      const response = await fetch('https://api.tvmaze.com/updates/shows');

      if (!response.ok) {
        throw new Error('TVMaze updates fetch failed');
      }

      const updates = await response.json();
      
      // Get the most recently updated show IDs (indicates active/trending shows)
      const showIds = Object.keys(updates)
        .sort((a, b) => updates[b] - updates[a])
        .slice(0, 20);

      // Fetch details for each show
      const showPromises = showIds.map(async (id) => {
        try {
          const showResponse = await fetch(`https://api.tvmaze.com/shows/${id}`);
          if (showResponse.ok) {
            return await showResponse.json();
          }
          return null;
        } catch (e) {
          return null;
        }
      });

      const shows = (await Promise.all(showPromises)).filter(Boolean);

      const results = shows.map((show: any) => ({
        id: show.id,
        imdb_id: show.externals?.imdb || null,
        name: show.name,
        title: show.name,
        overview: show.summary?.replace(/<[^>]*>/g, '') || '',
        first_air_date: show.premiered,
        vote_average: show.rating?.average || 0,
        poster_path: show.image?.original || null,
        backdrop_path: show.image?.original || null,
        genres: show.genres || [],
        year: show.premiered ? new Date(show.premiered).getFullYear().toString() : null,
        status: show.status,
        network: show.network?.name || null,
        total_seasons: show._embedded?.seasons?.length || null,
      }));

      return { results };
    } catch (error) {
      console.error('Trending TV shows error:', error);
      throw error;
    }
  },
});
