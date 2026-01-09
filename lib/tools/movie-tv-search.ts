import { tool } from 'ai';
import { z } from 'zod';
import { serverEnv } from '@/env/server';

export const movieTvSearchTool = tool({
  description: 'Search for a movie or TV show using OMDb API',
  inputSchema: z.object({
    query: z.string().describe('The search query for movies/TV shows'),
  }),
  execute: async ({ query }: { query: string }) => {
    const OMDB_API_KEY = serverEnv.OMDB_API_KEY;

    try {
      // Search for the title
      const searchResponse = await fetch(
        `https://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${OMDB_API_KEY}`,
      );

      if (!searchResponse.ok) {
        console.error('OMDb search error:', searchResponse.statusText);
        return { result: null };
      }

      const searchData = await searchResponse.json();

      if (searchData.Response === 'False' || !searchData.Search || searchData.Search.length === 0) {
        return { result: null };
      }

      const firstResult = searchData.Search[0];

      // Get full details
      const detailsResponse = await fetch(
        `https://www.omdbapi.com/?i=${firstResult.imdbID}&plot=full&apikey=${OMDB_API_KEY}`,
      );

      if (!detailsResponse.ok) {
        console.error('OMDb details error:', detailsResponse.statusText);
        return { result: null };
      }

      const details = await detailsResponse.json();

      if (details.Response === 'False') {
        return { result: null };
      }

      // Parse actors into cast format
      const cast = details.Actors && details.Actors !== 'N/A'
        ? details.Actors.split(', ').slice(0, 8).map((name: string, index: number) => ({
            id: index,
            name,
            character: '',
            profile_path: null,
          }))
        : [];

      const result = {
        id: details.imdbID,
        imdb_id: details.imdbID,
        title: details.Title,
        name: details.Title,
        media_type: details.Type === 'series' ? 'tv' : 'movie',
        overview: details.Plot !== 'N/A' ? details.Plot : '',
        release_date: details.Released !== 'N/A' ? details.Released : null,
        first_air_date: details.Released !== 'N/A' ? details.Released : null,
        vote_average: details.imdbRating !== 'N/A' ? parseFloat(details.imdbRating) : 0,
        vote_count: details.imdbVotes !== 'N/A' ? parseInt(details.imdbVotes.replace(/,/g, '')) : 0,
        genres: details.Genre !== 'N/A' ? details.Genre.split(', ') : [],
        poster_path: details.Poster !== 'N/A' ? details.Poster : null,
        backdrop_path: details.Poster !== 'N/A' ? details.Poster : null,
        runtime: details.Runtime !== 'N/A' ? parseInt(details.Runtime) : null,
        status: details.Type === 'series' ? 'Released' : null,
        language: details.Language !== 'N/A' ? details.Language : null,
        country: details.Country !== 'N/A' ? details.Country : null,
        awards: details.Awards !== 'N/A' ? details.Awards : null,
        rated: details.Rated !== 'N/A' ? details.Rated : null,
        year: details.Year !== 'N/A' ? details.Year : null,
        credits: {
          cast,
          director: details.Director !== 'N/A' ? details.Director : null,
          writer: details.Writer !== 'N/A' ? details.Writer : null,
        },
      };

      return { result };
    } catch (error) {
      console.error('OMDb search error:', error);
      throw error;
    }
  },
});
