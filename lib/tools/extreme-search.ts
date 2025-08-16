// extremeSearch(researchPrompt)
// --> Plan research using LLM to generate a structured research plan
// ----> Break research into components with discrete search queries
// ----> For each search query, search web and collect sources
// ----> Use structured source collection to provide comprehensive research results
// ----> Return all collected sources and research data to the user

import { Exa } from 'exa-js';
import { generateText, tool, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import { serverEnv } from '@/env/server';
import { myProvider } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/types';

type SearchResult = {
  title: string;
  url: string;
  content: string;
  summary?: string;
};

type Research = {
  text: string;
  toolResults: any[];
  sources: SearchResult[];
  charts: any[];
};

export const exa = new Exa(serverEnv.EXA_API_KEY);

const extremeSearch = async (prompt: string, dataStream?: UIMessageStreamWriter<ChatMessage>): Promise<Research> => {
  try {
    // Simplified research approach
    const searchResults = await exa.searchAndContents(prompt, {
      type: 'auto',
      numResults: 10,
      summary: {
        query: `Provide a comprehensive summary for: ${prompt}`,
      },
    });

    const sources: SearchResult[] = searchResults.results.map((result: any) => ({
      title: result.title || '',
      url: result.url,
      content: result.content || result.summary || '',
      summary: result.summary,
    }));

    // Generate comprehensive research text
    const { text } = await generateText({
      model: myProvider.languageModel('chat-model'),
      system: `You are a research assistant. Provide a comprehensive analysis based on the search results provided.`,
      prompt: `Research topic: ${prompt}

Search results:
${sources.map(source => `Title: ${source.title}\nURL: ${source.url}\nSummary: ${source.summary}\n`).join('\n')}

Please provide a detailed analysis and summary of this research topic.`,
    });

    return {
      text,
      toolResults: [],
      sources,
      charts: [],
    };
  } catch (error) {
    console.error('Extreme search error:', error);
    return {
      text: `Error conducting research: ${error instanceof Error ? error.message : 'Unknown error'}`,
      toolResults: [],
      sources: [],
      charts: [],
    };
  }
};

export const extremeSearchTool = (dataStream?: UIMessageStreamWriter<ChatMessage>) => {
  return tool({
    description: 'Use this tool to conduct an extreme search on a given topic.',
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          "This should take the user's exact prompt. Extract from the context but do not infer or change in any way.",
        ),
    }),
    execute: async ({ prompt }) => {
      const research = await extremeSearch(prompt, dataStream);
      return {
        research: {
          text: research.text,
          toolResults: research.toolResults,
          sources: research.sources,
          charts: research.charts,
        },
      };
    },
  });
};