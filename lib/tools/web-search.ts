import { tool, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import { Exa } from 'exa-js';
import { serverEnv } from '@/env/server';

// Simple in-memory cache with 5-minute TTL
const searchCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const getCachedResult = (cacheKey: string) => {
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  if (cached) {
    searchCache.delete(cacheKey); // Remove expired cache
  }
  return null;
};

const setCachedResult = (cacheKey: string, data: any) => {
  searchCache.set(cacheKey, { data, timestamp: Date.now() });
};

const extractDomain = (url: string): string => {
  const urlPattern = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i;
  return url.match(urlPattern)?.[1] || url;
};

const cleanTitle = (title: string): string => {
  // Remove content within square brackets and parentheses, then trim whitespace
  return title
    .replace(/\[.*?\]/g, '') // Remove [content]
    .replace(/\(.*?\)/g, '') // Remove (content)
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .trim(); // Remove leading/trailing whitespace
};

const deduplicateByDomainAndUrl = <T extends { url: string }>(items: T[]): T[] => {
  const seenDomains = new Set<string>();
  const seenUrls = new Set<string>();

  return items.filter((item) => {
    const domain = extractDomain(item.url);
    const isNewUrl = !seenUrls.has(item.url);
    const isNewDomain = !seenDomains.has(domain);

    if (isNewUrl && isNewDomain) {
      seenUrls.add(item.url);
      seenDomains.add(domain);
      return true;
    }
    return false;
  });
};

const processDomains = (domains?: string[]): string[] | undefined => {
  if (!domains || domains.length === 0) return undefined;

  const processedDomains = domains.map((domain) => extractDomain(domain));
  return processedDomains.every((domain) => domain.trim() === '') ? undefined : processedDomains;
};

export const webSearchTool = (dataStream: UIMessageStreamWriter<any>) => {
  return tool({
    description: 'Search the web for current information using 2-4 focused queries. Fast parallel search with smart deduplication.',
    inputSchema: z.object({
      queries: z.array(
        z.string().describe('Array of 2-4 focused search queries. Use specific, targeted queries for best results.'),
      ),
      maxResults: z.array(
        z.number().describe('Array of maximum number of results to return per query. Default is 5.'),
      ).optional().default([5]),
      topics: z.array(
        z.enum(['general', 'news', 'finance']).describe('Array of topic types to search for. Default is general.'),
      ).optional().default(['general']),
      quality: z.enum(['default', 'best']).describe('Search quality x speed level. Default is default.').optional().default('default'),
      include_domains: z
        .array(z.string())
        .describe('An array of domains to include in all search results. Default is an empty list.')
        .optional().default([]),
      exclude_domains: z
        .array(z.string())
        .describe('An array of domains to exclude from all search results. Default is an empty list.')
        .optional().default([]),
    }),
    execute: async ({ queries, maxResults, topics, quality, include_domains, exclude_domains }) => {
      const startTime = Date.now();
      console.log('🔍 [WEB SEARCH] Tool called with queries:', queries);
      const exa = new Exa(serverEnv.EXA_API_KEY);
      
      try {
        // Execute all searches in parallel for much faster performance
        const searchPromises = queries.map(async (query, i) => {
          const maxResult = maxResults?.[i] || maxResults?.[0] || 5;
          const topic = topics?.[i] || topics?.[0] || 'general';
          
          // Create cache key from query parameters
          const cacheKey = `${query}:${maxResult}:${topic}:${JSON.stringify(include_domains)}:${JSON.stringify(exclude_domains)}`;
          
          // Check cache first
          const cachedResult = getCachedResult(cacheKey);
          if (cachedResult) {
            console.log(`🔍 [WEB SEARCH] Cache hit for query: ${query}`);
            return cachedResult;
          }

          const searchOptions = {
            type: (topic === 'news' ? 'neural' : 'auto') as 'neural' | 'auto',
            numResults: maxResult,
            includeDomains: processDomains(include_domains),
            excludeDomains: processDomains(exclude_domains),
            summary: {
              query: `Summarize this content for: ${query}`,
            },
          };

          const result = await exa.searchAndContents(query, searchOptions);
          
          // Cache the result
          setCachedResult(cacheKey, result);
          
          return result;
        });

        const searchResults = await Promise.all(searchPromises);
        const allResults = searchResults.flatMap(result => result.results);

        const deduplicatedResults = deduplicateByDomainAndUrl(allResults);
        
        const totalTime = Date.now() - startTime;
        console.log(`🔍 [WEB SEARCH] Completed ${queries.length} queries in ${totalTime}ms (${deduplicatedResults.length} results)`);
        
        return {
          results: deduplicatedResults.map(result => ({
            title: cleanTitle(result.title || ''),
            url: result.url,
            summary: result.summary || '',
            content: result.text || '',
          })),
        };
      } catch (error) {
        throw error;
      }
    },
  });
};