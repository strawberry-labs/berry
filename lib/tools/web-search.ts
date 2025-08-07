import { tool, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import Exa from 'exa-js';
import { serverEnv } from '@/env/server';
import type { ChatMessage } from '@/lib/types';

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

export const webSearchTool = (dataStream: UIMessageStreamWriter<ChatMessage>) =>
  tool({
    description: 'Search the web for information with 5-10 queries, max results and search depth.',
    inputSchema: z.object({
      queries: z.array(
        z.string().describe('Array of search queries to look up on the web. Default is 5 to 10 queries.'),
      ),
      maxResults: z.array(
        z.number().describe('Array of maximum number of results to return per query. Default is 10.'),
      ),
      topics: z.array(
        z.enum(['general', 'news', 'finance']).describe('Array of topic types to search for. Default is general.'),
      ),
      quality: z.enum(['default', 'best']).describe('Search quality x speed level. Default is default.'),
      include_domains: z
        .array(z.string())
        .describe('An array of domains to include in all search results. Default is an empty list.'),
      exclude_domains: z
        .array(z.string())
        .describe('An array of domains to exclude from all search results. Default is an empty list.'),
    }),
    execute: async ({ queries, maxResults, topics, quality, include_domains, exclude_domains }) => {
      const exa = new Exa(serverEnv.EXA_API_KEY);
      
      try {
        const allResults: any[] = [];
        
        for (let i = 0; i < queries.length; i++) {
          const query = queries[i];
          const maxResult = maxResults[i] || 10;
          const topic = topics[i] || 'general';

          const searchResult = await exa.searchAndContents(query, {
            type: topic === 'news' ? 'neural' : 'auto',
            numResults: maxResult,
            includeDomains: processDomains(include_domains),
            excludeDomains: processDomains(exclude_domains),
            summary: {
              query: `Summarize this content for: ${query}`,
            },
          });

          allResults.push(...searchResult.results);
        }

        const deduplicatedResults = deduplicateByDomainAndUrl(allResults);
        
        return {
          results: deduplicatedResults.map(result => ({
            title: cleanTitle(result.title || ''),
            url: result.url,
            summary: result.summary || '',
            content: result.text || '',
          })),
        };
      } catch (error) {
        console.error('Web search error:', error);
        throw error;
      }
    },
  });