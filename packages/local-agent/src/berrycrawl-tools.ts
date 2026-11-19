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
 * Browser contracts reviewed against the live official MCP catalog on 2026-11-04.
 * Only direct browser controls are included; Berry Chat runs its own agent loop.
 * No browser session or external service is contacted when loading this catalog.
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
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "format": "uri",
          "description": "Public HTTP(S) URL to scrape."
        },
        "formats": {
          "default": [
            "markdown"
          ],
          "description": "Output formats to return in one browser pass.",
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
          "default": 172800000,
          "description": "Cache age in milliseconds. Set 0 to force a refresh.",
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
          "default": "auto",
          "description": "Proxy strategy. auto starts direct and escalates only when blocked.",
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
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
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
      "$schema": "http://json-schema.org/draft-07/schema#",
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
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "format": "uri",
          "description": "Public HTTP(S) URL to capture."
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
          "default": true,
          "description": "Remove cookie and consent banners using the seven-layer cleanup flow. Enabled by default; set false to preserve the original page.",
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
          "default": "auto",
          "description": "Proxy strategy. auto starts direct and escalates only when blocked.",
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
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
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
      "$schema": "http://json-schema.org/draft-07/schema#",
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
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "format": "uri",
          "description": "Public site URL to map."
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
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
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
      "$schema": "http://json-schema.org/draft-07/schema#",
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
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500,
          "description": "Web search query."
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
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
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
      "$schema": "http://json-schema.org/draft-07/schema#",
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
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "format": "uri",
          "description": "Public website URL, for example https://berrycrawl.com."
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
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
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
      "$schema": "http://json-schema.org/draft-07/schema#",
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
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "format": "uri",
          "description": "Public starting URL for the crawl."
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
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
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
      "$schema": "http://json-schema.org/draft-07/schema#",
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
      "type": "object",
      "properties": {
        "job_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "response_format": {
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
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
      "$schema": "http://json-schema.org/draft-07/schema#",
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
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
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
      "$schema": "http://json-schema.org/draft-07/schema#",
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
      "type": "object",
      "properties": {
        "response_format": {
          "default": "markdown",
          "description": "Use markdown for model-readable output or json for programmatic output.",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_open",
    "description": "Use a persistent browser session to open. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "format": "uri"
        },
        "proxy": {
          "type": "string",
          "enum": [
            "none",
            "datacenter",
            "residential",
            "auto"
          ]
        },
        "country": {
          "type": "string",
          "minLength": 2,
          "maxLength": 2
        },
        "metadata": {
          "description": "Up to 10 tags for finding this session later.",
          "type": "object",
          "propertyNames": {
            "type": "string",
            "maxLength": 40
          },
          "additionalProperties": {
            "type": "string",
            "maxLength": 256
          }
        },
        "record": {
          "description": "Record a video of the session, saved as a file on close.",
          "type": "boolean"
        },
        "timeout_seconds": {
          "type": "integer",
          "minimum": 30,
          "maximum": 3600
        },
        "max_credits": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10000000
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_navigate",
    "description": "Use a persistent browser session to navigate. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "tab_id": {
          "description": "Act in this open tab (see tabs) without switching to it. Defaults to the active tab.",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "url": {
          "type": "string",
          "format": "uri"
        },
        "snapshot": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "session_id",
        "url"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_snapshot",
    "description": "Use a persistent browser session to snapshot. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "tab_id": {
          "description": "Act in this open tab (see tabs) without switching to it. Defaults to the active tab.",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "depth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "boxes": {
          "default": false,
          "type": "boolean"
        },
        "max_chars": {
          "default": 12000,
          "type": "integer",
          "minimum": 100,
          "maximum": 60000
        }
      },
      "required": [
        "session_id"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_click",
    "description": "Use a persistent browser session to click. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "tab_id": {
          "description": "Act in this open tab (see tabs) without switching to it. Defaults to the active tab.",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "ref": {
          "type": "string",
          "maxLength": 200
        },
        "selector": {
          "type": "string",
          "maxLength": 2048
        },
        "x": {
          "type": "number",
          "minimum": 0
        },
        "y": {
          "type": "number",
          "minimum": 0
        },
        "snapshot": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "session_id"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_type",
    "description": "Use a persistent browser session to type. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "tab_id": {
          "description": "Act in this open tab (see tabs) without switching to it. Defaults to the active tab.",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "ref": {
          "type": "string",
          "maxLength": 200
        },
        "selector": {
          "type": "string",
          "maxLength": 2048
        },
        "x": {
          "type": "number",
          "minimum": 0
        },
        "y": {
          "type": "number",
          "minimum": 0
        },
        "text": {
          "type": "string",
          "maxLength": 10000
        },
        "clear": {
          "default": true,
          "type": "boolean"
        },
        "submit": {
          "default": false,
          "type": "boolean"
        },
        "snapshot": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "session_id",
        "text"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_press",
    "description": "Use a persistent browser session to press. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "tab_id": {
          "description": "Act in this open tab (see tabs) without switching to it. Defaults to the active tab.",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "ref": {
          "type": "string",
          "maxLength": 200
        },
        "selector": {
          "type": "string",
          "maxLength": 2048
        },
        "x": {
          "type": "number",
          "minimum": 0
        },
        "y": {
          "type": "number",
          "minimum": 0
        },
        "key": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "snapshot": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "session_id",
        "key"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_scroll",
    "description": "Use a persistent browser session to scroll. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "tab_id": {
          "description": "Act in this open tab (see tabs) without switching to it. Defaults to the active tab.",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "ref": {
          "type": "string",
          "maxLength": 200
        },
        "selector": {
          "type": "string",
          "maxLength": 2048
        },
        "x": {
          "type": "number",
          "minimum": 0
        },
        "y": {
          "type": "number",
          "minimum": 0
        },
        "direction": {
          "default": "down",
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ]
        },
        "amount": {
          "default": 500,
          "type": "integer",
          "minimum": 0,
          "maximum": 10000
        },
        "snapshot": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "session_id"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_screenshot",
    "description": "Use a persistent browser session to screenshot. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "tab_id": {
          "description": "Act in this open tab (see tabs) without switching to it. Defaults to the active tab.",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        }
      },
      "required": [
        "session_id"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_read",
    "description": "Use a persistent browser session to read. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "tab_id": {
          "description": "Act in this open tab (see tabs) without switching to it. Defaults to the active tab.",
          "type": "string",
          "minLength": 1,
          "maxLength": 100
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
        }
      },
      "required": [
        "session_id"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_tabs",
    "description": "Use a persistent browser session to list tabs (use act to open, switch or close tabs; pass tab_id to other tools to act in a tab without switching). Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "op": {
          "default": "list",
          "type": "string",
          "const": "list"
        }
      },
      "required": [
        "session_id"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_files",
    "description": "Use a persistent browser session to list private file metadata or read a file. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "file_id": {
          "type": "string",
          "pattern": "^bfile_[a-zA-Z0-9-]+$"
        },
        "content": {
          "default": false,
          "description": "With file_id, return the file itself (up to 2 MB): text as UTF-8, images as an image, other files as base64.",
          "type": "boolean"
        }
      },
      "required": [
        "session_id"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_act",
    "description": "Use a persistent browser session to act. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        },
        "actions": {
          "minItems": 1,
          "maxItems": 25,
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "navigate"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "url": {
                    "type": "string",
                    "maxLength": 8192,
                    "format": "uri"
                  },
                  "wait_until": {
                    "default": "domcontentloaded",
                    "type": "string",
                    "enum": [
                      "domcontentloaded",
                      "load",
                      "networkidle"
                    ]
                  },
                  "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 60000
                  }
                },
                "required": [
                  "type",
                  "url"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "back"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 60000
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "forward"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 60000
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "reload"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 60000
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "snapshot"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "depth": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100
                  },
                  "boxes": {
                    "default": false,
                    "type": "boolean"
                  },
                  "max_chars": {
                    "default": 20000,
                    "type": "integer",
                    "minimum": 100,
                    "maximum": 60000
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "click"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "button": {
                    "type": "string",
                    "enum": [
                      "left",
                      "right",
                      "middle"
                    ]
                  },
                  "click_count": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 3
                  },
                  "modifiers": {
                    "maxItems": 5,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "Alt",
                        "Control",
                        "ControlOrMeta",
                        "Meta",
                        "Shift"
                      ]
                    }
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "write"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "text": {
                    "type": "string",
                    "maxLength": 10000
                  },
                  "clear": {
                    "default": true,
                    "type": "boolean"
                  },
                  "submit": {
                    "default": false,
                    "type": "boolean"
                  },
                  "sensitive": {
                    "default": true,
                    "type": "boolean"
                  }
                },
                "required": [
                  "type",
                  "text"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "press"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "key": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  }
                },
                "required": [
                  "type",
                  "key"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "select"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "values": {
                    "minItems": 1,
                    "maxItems": 100,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "maxLength": 1000
                    }
                  }
                },
                "required": [
                  "type",
                  "values"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "hover"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "scroll"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "direction": {
                    "default": "down",
                    "type": "string",
                    "enum": [
                      "up",
                      "down",
                      "left",
                      "right"
                    ]
                  },
                  "amount": {
                    "default": 500,
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10000
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "wait"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "ms": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10000
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "text": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 10000
                  },
                  "url": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 8192
                  },
                  "load_state": {
                    "type": "string",
                    "enum": [
                      "domcontentloaded",
                      "load",
                      "networkidle"
                    ]
                  },
                  "download": {
                    "type": "boolean",
                    "const": true
                  },
                  "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 30000
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "drag"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "to": {
                    "type": "object",
                    "properties": {
                      "ref": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      },
                      "selector": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2048
                      },
                      "locator": {
                        "type": "object",
                        "properties": {
                          "role": {
                            "type": "string",
                            "enum": [
                              "button",
                              "link",
                              "textbox",
                              "searchbox",
                              "checkbox",
                              "radio",
                              "combobox",
                              "option",
                              "menuitem",
                              "tab",
                              "switch",
                              "slider",
                              "spinbutton"
                            ]
                          },
                          "name": {
                            "type": "string",
                            "maxLength": 1000
                          }
                        },
                        "required": [
                          "role",
                          "name"
                        ],
                        "additionalProperties": false
                      },
                      "x": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 100000
                      },
                      "y": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 100000
                      }
                    },
                    "additionalProperties": false
                  }
                },
                "required": [
                  "type",
                  "to"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "cookies"
                  },
                  "op": {
                    "default": "get",
                    "type": "string",
                    "enum": [
                      "get",
                      "set",
                      "clear"
                    ]
                  },
                  "urls": {
                    "maxItems": 20,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "maxLength": 8192,
                      "format": "uri"
                    }
                  },
                  "cookies": {
                    "minItems": 1,
                    "maxItems": 50,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "name": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 256
                        },
                        "value": {
                          "type": "string",
                          "maxLength": 4096
                        },
                        "url": {
                          "type": "string",
                          "maxLength": 8192,
                          "format": "uri"
                        },
                        "domain": {
                          "type": "string",
                          "maxLength": 253
                        },
                        "path": {
                          "type": "string",
                          "maxLength": 1024
                        },
                        "expires": {
                          "type": "number"
                        },
                        "httpOnly": {
                          "type": "boolean"
                        },
                        "secure": {
                          "type": "boolean"
                        },
                        "sameSite": {
                          "type": "string",
                          "enum": [
                            "Strict",
                            "Lax",
                            "None"
                          ]
                        }
                      },
                      "required": [
                        "name",
                        "value"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "screenshot"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "full_page": {
                    "default": false,
                    "type": "boolean"
                  },
                  "format": {
                    "default": "jpeg",
                    "type": "string",
                    "enum": [
                      "jpeg",
                      "png"
                    ]
                  },
                  "quality": {
                    "default": 75,
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100
                  },
                  "response": {
                    "default": "url",
                    "type": "string",
                    "enum": [
                      "url",
                      "base64"
                    ]
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "scrape"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "formats": {
                    "default": [
                      "markdown"
                    ],
                    "minItems": 1,
                    "maxItems": 4,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "markdown",
                        "html",
                        "links",
                        "images"
                      ]
                    }
                  },
                  "only_main_content": {
                    "default": true,
                    "type": "boolean"
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "extract"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
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
                  }
                },
                "required": [
                  "type",
                  "prompt"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "pdf"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "tabs"
                  },
                  "op": {
                    "default": "list",
                    "type": "string",
                    "enum": [
                      "list",
                      "new",
                      "switch",
                      "close"
                    ]
                  },
                  "tab_id": {
                    "type": "string",
                    "maxLength": 100
                  },
                  "url": {
                    "type": "string",
                    "maxLength": 8192,
                    "format": "uri"
                  }
                },
                "required": [
                  "type"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "upload"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "locator": {
                    "type": "object",
                    "properties": {
                      "role": {
                        "type": "string",
                        "enum": [
                          "button",
                          "link",
                          "textbox",
                          "searchbox",
                          "checkbox",
                          "radio",
                          "combobox",
                          "option",
                          "menuitem",
                          "tab",
                          "switch",
                          "slider",
                          "spinbutton"
                        ]
                      },
                      "name": {
                        "type": "string",
                        "maxLength": 1000
                      }
                    },
                    "required": [
                      "role",
                      "name"
                    ],
                    "additionalProperties": false
                  },
                  "ref": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "selector": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "x": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "y": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 100000
                  },
                  "file_ids": {
                    "minItems": 1,
                    "maxItems": 20,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^bfile_[a-zA-Z0-9-]+$"
                    }
                  }
                },
                "required": [
                  "type",
                  "file_ids"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "dialog"
                  },
                  "accept": {
                    "type": "boolean"
                  },
                  "prompt_text": {
                    "type": "string",
                    "maxLength": 10000
                  }
                },
                "required": [
                  "type",
                  "accept"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "evaluate"
                  },
                  "tab_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "expression": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 10000
                  }
                },
                "required": [
                  "type",
                  "expression"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "stop_on_error": {
          "default": true,
          "type": "boolean"
        },
        "timeout_ms": {
          "default": 30000,
          "type": "integer",
          "minimum": 1,
          "maximum": 60000
        },
        "snapshot": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "session_id",
        "actions"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
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
    "name": "berrycrawl_browser_close",
    "description": "Use a persistent browser session to close. Sessions cost 1 credit per minute plus proxy traffic; see pricing. Take a fresh snapshot after navigation; refs expire on navigation.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "session_id": {
          "type": "string",
          "pattern": "^bses_[a-zA-Z0-9-]+$"
        },
        "response_format": {
          "default": "markdown",
          "type": "string",
          "enum": [
            "markdown",
            "json"
          ]
        }
      },
      "required": [
        "session_id"
      ],
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  }
];

export const BERRYCRAWL_DEFAULT_TOOL_NAMES = [
  "berrycrawl_search_web",
  "berrycrawl_scrape_url",
  "berrycrawl_get_brand",
  "berrycrawl_start_crawl",
  "berrycrawl_get_job",
  "berrycrawl_browser_open",
  "berrycrawl_browser_navigate",
  "berrycrawl_browser_snapshot",
  "berrycrawl_browser_click",
  "berrycrawl_browser_type",
  "berrycrawl_browser_press",
  "berrycrawl_browser_scroll",
  "berrycrawl_browser_screenshot",
  "berrycrawl_browser_read",
  "berrycrawl_browser_close"
] as const;

/** Billed reads and browser mutations must not be replayed after an ambiguous outcome. */
export const BERRYCRAWL_NON_REPLAYABLE_TOOL_NAMES = [
  "berrycrawl_scrape_url",
  "berrycrawl_capture_screenshot",
  "berrycrawl_map_site",
  "berrycrawl_search_web",
  "berrycrawl_get_brand",
  "berrycrawl_browser_open",
  "berrycrawl_browser_navigate",
  "berrycrawl_browser_click",
  "berrycrawl_browser_type",
  "berrycrawl_browser_press",
  "berrycrawl_browser_scroll",
  "berrycrawl_browser_act",
  "berrycrawl_browser_close"
] as const;
