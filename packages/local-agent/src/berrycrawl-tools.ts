export type BundledMcpToolDefinition = {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

/**
 * Reviewed snapshot of the official BerryCrawl MCP catalog.
 *
 * Live definitions are compared with this catalog before an allow-listed tool
 * executes. A changed definition is disabled until this snapshot is reviewed
 * and republished.
 */
export const BERRYCRAWL_TOOL_CATALOG: BundledMcpToolDefinition[] = [
  {
    "name": "berrycrawl_scrape_url",
    "description": "Scrape one public URL with Berrycrawl. YouTube video URLs automatically return timestamped transcripts; every successful transcript response costs 5 credits. Other URLs return requested text/HTML/link/image formats using Patchright and automatic proxy escalation when needed. Cached ordinary page scrapes and failed requests are free.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "url": {
          "description": "Public HTTP(S) URL to scrape.",
          "type": "string",
          "format": "uri"
        },
        "formats": {
          "description": "Output formats to return in one browser pass.",
          "default": [
            "markdown"
          ],
          "minItems": 1,
          "maxItems": 6,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "markdown",
              "html",
              "rawHtml",
              "links",
              "images",
              "summary"
            ]
          }
        },
        "only_main_content": {
          "default": true,
          "type": "boolean"
        },
        "include_tags": {
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "exclude_tags": {
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "wait_for_ms": {
          "default": 0,
          "type": "integer",
          "minimum": 0,
          "maximum": 30000
        },
        "max_age_ms": {
          "description": "Cache age in milliseconds. Set 0 to force a refresh.",
          "default": 172800000,
          "type": "integer",
          "minimum": 0,
          "maximum": 7776000000
        },
        "timeout_ms": {
          "default": 30000,
          "type": "integer",
          "minimum": 1000,
          "maximum": 60000
        },
        "proxy": {
          "description": "Proxy strategy. auto starts direct and escalates only when blocked.",
          "default": "auto",
          "type": "string",
          "enum": [
            "none",
            "basic",
            "datacenter",
            "residential",
            "stealth",
            "auto"
          ]
        },
        "mobile": {
          "default": false,
          "type": "boolean"
        },
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "berrycrawl_capture_screenshot",
    "description": "Capture a clean full-page, viewport, or element screenshot. Cookie banners, overlays, and chat widgets are removed by default, with controls to preserve them. Supports lazy-page scrolling, tall-page stitching, device presets, privacy masks, PNG, JPEG, WebP, URL output, and base64 output.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "url": {
          "description": "Public HTTP(S) URL to capture.",
          "type": "string",
          "format": "uri"
        },
        "full_page": {
          "default": true,
          "type": "boolean"
        },
        "image_format": {
          "default": "png",
          "type": "string",
          "enum": [
            "png",
            "jpeg",
            "webp"
          ]
        },
        "quality": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "image_response_format": {
          "default": "url",
          "type": "string",
          "enum": [
            "url",
            "base64"
          ]
        },
        "omit_background": {
          "default": false,
          "type": "boolean"
        },
        "selector": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        },
        "device": {
          "default": "desktop",
          "type": "string",
          "enum": [
            "desktop",
            "desktop-hd",
            "tablet",
            "iphone-15",
            "pixel-8"
          ]
        },
        "viewport_width": {
          "type": "integer",
          "minimum": 320,
          "maximum": 3840
        },
        "viewport_height": {
          "type": "integer",
          "minimum": 240,
          "maximum": 2160
        },
        "color_scheme": {
          "type": "string",
          "enum": [
            "light",
            "dark"
          ]
        },
        "reduced_motion": {
          "default": true,
          "type": "boolean"
        },
        "wait_until": {
          "default": "networkidle",
          "type": "string",
          "enum": [
            "domcontentloaded",
            "load",
            "networkidle"
          ]
        },
        "delay_ms": {
          "default": 0,
          "type": "integer",
          "minimum": 0,
          "maximum": 30000
        },
        "wait_for_selector": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        },
        "click_selector": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        },
        "hide_selectors": {
          "default": [],
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          }
        },
        "mask_selectors": {
          "default": [],
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          }
        },
        "mask_color": {
          "default": "#000000",
          "type": "string",
          "pattern": "^#[0-9a-f]{6}$"
        },
        "remove_cookie_banners": {
          "description": "Remove cookie and consent banners using the seven-layer cleanup flow. Enabled by default; set false to preserve the original page.",
          "default": true,
          "type": "boolean"
        },
        "remove_overlays": {
          "default": true,
          "type": "boolean"
        },
        "remove_chat_widgets": {
          "default": true,
          "type": "boolean"
        },
        "scroll_page": {
          "default": true,
          "type": "boolean"
        },
        "scroll_delay_ms": {
          "default": 250,
          "type": "integer",
          "minimum": 50,
          "maximum": 2000
        },
        "full_page_algorithm": {
          "default": "auto",
          "type": "string",
          "enum": [
            "auto",
            "native",
            "stitch"
          ]
        },
        "max_height": {
          "default": 30000,
          "type": "integer",
          "minimum": 1000,
          "maximum": 50000
        },
        "hide_fixed_elements": {
          "default": true,
          "type": "boolean"
        },
        "disable_animations": {
          "default": true,
          "type": "boolean"
        },
        "timeout_ms": {
          "default": 30000,
          "type": "integer",
          "minimum": 1000,
          "maximum": 120000
        },
        "proxy": {
          "description": "Proxy strategy. auto starts direct and escalates only when blocked.",
          "default": "auto",
          "type": "string",
          "enum": [
            "none",
            "basic",
            "datacenter",
            "residential",
            "stealth",
            "auto"
          ]
        },
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "berrycrawl_map_site",
    "description": "Discover and filter URLs from a website using its sitemap and page links. Returns bounded link records and the exact credits used.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "url": {
          "description": "Public site URL to map.",
          "type": "string",
          "format": "uri"
        },
        "search": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        },
        "limit": {
          "default": 100,
          "type": "integer",
          "minimum": 1,
          "maximum": 1000
        },
        "sitemap": {
          "default": "include",
          "type": "string",
          "enum": [
            "include",
            "skip",
            "only"
          ]
        },
        "include_subdomains": {
          "default": true,
          "type": "boolean"
        },
        "ignore_query_parameters": {
          "default": true,
          "type": "boolean"
        },
        "timeout_ms": {
          "default": 30000,
          "type": "integer",
          "minimum": 1000,
          "maximum": 300000
        },
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "berrycrawl_search_web",
    "description": "Search the web with Parallel Turbo mode and return up to 10 ranked results with excerpts. This tool never scrapes the result pages and costs a flat 2 credits when results exist. Call berrycrawl_scrape_url separately only for specific result URLs that need full page content.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "query": {
          "description": "Web search query.",
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        },
        "limit": {
          "default": 10,
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "country": {
          "default": "US",
          "type": "string",
          "minLength": 2,
          "maxLength": 2
        },
        "categories": {
          "maxItems": 10,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 50
          }
        },
        "time_filter": {
          "type": "string",
          "minLength": 1,
          "maxLength": 30
        },
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "query"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "berrycrawl_get_brand",
    "description": "Send one website URL and receive its name, description, tagline, language, logos, images, colors, fonts, and social profiles.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "url": {
          "description": "Public website URL, for example https://berrycrawl.com.",
          "type": "string",
          "format": "uri"
        },
        "refresh": {
          "default": false,
          "type": "boolean"
        },
        "timeout_ms": {
          "default": 60000,
          "type": "integer",
          "minimum": 1000,
          "maximum": 120000
        },
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "berrycrawl_start_crawl",
    "description": "Start an asynchronous multi-page crawl. Returns a job ID immediately; poll it with berrycrawl_get_job. This creates a Berrycrawl job and consumes credits as pages complete.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "url": {
          "description": "Public starting URL for the crawl.",
          "type": "string",
          "format": "uri"
        },
        "limit": {
          "default": 100,
          "type": "integer",
          "minimum": 1,
          "maximum": 10000
        },
        "max_discovery_depth": {
          "default": 10,
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        },
        "include_paths": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          }
        },
        "exclude_paths": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          }
        },
        "crawl_entire_domain": {
          "default": false,
          "type": "boolean"
        },
        "allow_subdomains": {
          "default": false,
          "type": "boolean"
        },
        "delay_ms": {
          "default": 0,
          "type": "integer",
          "minimum": 0,
          "maximum": 60000
        },
        "sitemap": {
          "default": "include",
          "type": "string",
          "enum": [
            "include",
            "skip",
            "only"
          ]
        },
        "max_concurrency": {
          "default": 5,
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        },
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "berrycrawl_get_job",
    "description": "Read an existing crawl or extraction job, including progress, results, errors, and credits used.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "job_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "job_id"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "berrycrawl_start_extract",
    "description": "Start an asynchronous AI extraction job over up to 25 URLs using a natural-language prompt and optional JSON schema. Returns a job ID; poll with berrycrawl_get_job.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "urls": {
          "minItems": 1,
          "maxItems": 25,
          "type": "array",
          "items": {
            "type": "string",
            "format": "uri"
          }
        },
        "prompt": {
          "type": "string",
          "minLength": 1,
          "maxLength": 5000
        },
        "schema": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        },
        "enable_web_search": {
          "default": false,
          "type": "boolean"
        },
        "show_sources": {
          "default": true,
          "type": "boolean"
        },
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "urls",
        "prompt"
      ],
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "berrycrawl_get_credit_balance",
    "description": "Return the current Berrycrawl credit balance for the organization attached to this API key. This tool is free and does not expose payment details.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "response_format": {
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  }
];

export const BERRYCRAWL_DEFAULT_TOOL_NAMES = [
  "berrycrawl_search_web",
  "berrycrawl_scrape_url",
  "berrycrawl_get_brand",
  "berrycrawl_start_crawl",
  "berrycrawl_get_job",
] as const;

/**
 * Read-like calls that can still consume credits. If a worker stops after the
 * remote call succeeds, require recovery instead of replaying the call.
 */
export const BERRYCRAWL_NON_REPLAYABLE_TOOL_NAMES = [
  "berrycrawl_scrape_url",
  "berrycrawl_capture_screenshot",
  "berrycrawl_map_site",
  "berrycrawl_search_web",
  "berrycrawl_get_brand",
] as const;
