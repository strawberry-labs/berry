# Environment Variables Setup

This document describes the additional environment variables needed for the new AI tools integration.

## Required API Keys

Add these to your `.env.local` file:

```env
# Development & Sandbox APIs
# Get your Daytona API Key here: https://app.daytona.io/
DAYTONA_API_KEY=your_daytona_api_key_here

# Search & Web APIs  
# Get your Exa API Key here: https://exa.ai/
EXA_API_KEY=your_exa_api_key_here

# Optional: Get your Tavily API Key here: https://tavily.com/
TAVILY_API_KEY=your_tavily_api_key_here
```

## Tool Descriptions

- **DAYTONA_API_KEY**: Required for code execution in sandboxed environments (Code Interpreter & Extreme Search tools)
- **EXA_API_KEY**: Required for web search, academic search, and extreme research capabilities
- **TAVILY_API_KEY**: Optional, provides additional search capabilities for extreme research

## Getting API Keys

1. **Daytona**: Sign up at https://app.daytona.io/ and get your API key from the dashboard
2. **Exa**: Sign up at https://exa.ai/ and get your API key from the developer console
3. **Tavily**: Sign up at https://tavily.com/ (optional, for enhanced search)

## Tool Categories

- **Web Search**: General-purpose web search with multiple queries
- **Academic Search**: Specialized search for academic papers and research
- **Code Interpreter**: Execute Python code in a sandboxed environment
- **Extreme Search**: Deep research with multiple sources and analysis
- **Analysis**: Code execution with datetime utilities 