export const docsNavigation = [
  {
    section: "Start",
    pages: [
      { title: "Overview", source: "docs/site-home.md", output: "index.html" },
      { title: "Ollama in 5 minutes", source: "docs/quickstarts/ollama.md", output: "quickstarts/ollama.html" },
      { title: "LM Studio", source: "docs/quickstarts/lm-studio.md", output: "quickstarts/lm-studio.html" },
      { title: "OpenRouter and Router", source: "docs/quickstarts/openrouter-router.md", output: "quickstarts/openrouter-router.html" },
      { title: "Self-host Compose", source: "docs/quickstarts/self-host-compose.md", output: "quickstarts/self-host-compose.html" },
      { title: "Helm", source: "docs/quickstarts/helm.md", output: "quickstarts/helm.html" }
    ]
  },
  {
    section: "Reference",
    pages: [
      { title: "CLI", source: "docs/reference/cli.md", output: "reference/cli.html" },
      { title: "Host Protocol", source: "docs/protocol/host-methods.md", output: "reference/host-protocol.html" },
      { title: "Desktop Release", source: "docs/desktop-release.md", output: "reference/desktop-release.html" },
      { title: "Providers", source: "docs/providers.md", output: "reference/providers.html" }
    ]
  },
  {
    section: "Operate",
    pages: [
      { title: "Policy and Admin", source: "docs/admin/policy-admin-guide.md", output: "operate/policy-admin.html" },
      { title: "Managed Policy", source: "docs/managed-policy.md", output: "operate/managed-policy.html" },
      { title: "Sandbox", source: "docs/sandbox.md", output: "operate/sandbox.html" },
      { title: "Security Review", source: "docs/security-review.md", output: "operate/security-review.html" }
    ]
  },
  {
    section: "Extend",
    pages: [
      { title: "Plugin, Skill, and MCP Authoring", source: "docs/authoring/index.md", output: "extend/authoring.html" },
      { title: "Plugins", source: "docs/plugins.md", output: "extend/plugins.html" },
      { title: "Skills", source: "docs/skills.md", output: "extend/skills.html" },
      { title: "MCP", source: "docs/mcp.md", output: "extend/mcp.html" },
      { title: "Import Agent Configs", source: "docs/migration/import-agent-configs.md", output: "extend/import-agent-configs.html" }
    ]
  }
];

export const requiredDocs = [
  "docs/quickstarts/ollama.md",
  "docs/quickstarts/lm-studio.md",
  "docs/quickstarts/openrouter-router.md",
  "docs/quickstarts/self-host-compose.md",
  "docs/quickstarts/helm.md",
  "docs/reference/cli.md",
  "docs/protocol/host-methods.md",
  "docs/admin/policy-admin-guide.md",
  "docs/authoring/index.md",
  "docs/migration/import-agent-configs.md"
];
