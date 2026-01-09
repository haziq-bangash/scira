import { tool } from 'ai';
import { z } from 'zod';

export const trendingMoviesTool = tool({
  description: 'Get trending TV shows and movies airing today',
  inputSchema: z.object({}),
  execute: async () => {
    try {
      // Get today's schedule for popular shows (TVMaze has live data)
      const today = new Date().toISOString().split('T')[0];
      const response = await fetch(`https://api.tvmaze.com/schedule?date=${today}&country=US`);

      if (!response.ok) {
        throw new Error('TVMaze schedule fetch failed');
      }

      const data = await response.json();
      
      // Get unique shows with highest ratings
      const showMap = new Map();
      data.forEach((episode: any) => {
        const show = episode.show;
        if (!showMap.has(show.id) && show.rating?.average) {
          showMap.set(show.id, show);
        }
      });

      const results = Array.from(showMap.values())
        .sort((a: any, b: any) => (b.rating?.average || 0) - (a.rating?.average || 0))
        .slice(0, 20)
        .map((show: any) => ({
          id: show.id,
          imdb_id: show.externals?.imdb || null,
          name: show.name,
          title: show.name,
          overview: show.summary?.replace(/<[^>]*>/g, '') || '',
          vote_average: show.rating?.average || 0,
          poster_path: show.image?.original || null,
          backdrop_path: show.image?.original || null,
          first_air_date: show.premiered,
          release_date: show.premiered,
          genres: show.genres || [],
          year: show.premiered ? new Date(show.premiered).getFullYear().toString() : null,
        }));

      return { results };
    } catch (error) {
      console.error('Trending shows error:', error);
      throw error;
    }
  },
});
