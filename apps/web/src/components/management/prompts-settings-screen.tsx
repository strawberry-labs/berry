import * as React from "react";
import { Play, RotateCcw, Trash2 } from "lucide-react";
import {
  Button,
  Input,
  ManagementPage,
  Section,
  Textarea,
} from "./management-primitives";

const DEFAULT_PROMPTS = [
  {
    id: "review",
    name: "Review this change",
    trigger: "/review",
    body: "Review the current changes for correctness, security, and maintainability.",
  },
  {
    id: "explain",
    name: "Explain selection",
    trigger: "/explain",
    body: "Explain the selected code clearly, including its inputs, outputs, and edge cases.",
  },
];

type SavedPrompt = (typeof DEFAULT_PROMPTS)[number];

export function PromptsSettingsScreen({ onUsePrompt }: { onUsePrompt: (prompt: string) => void }) {
  const [prompts, setPrompts] = React.useState<SavedPrompt[]>(DEFAULT_PROMPTS);
  const [selected, setSelected] = React.useState("review");
  const item = prompts.find((prompt) => prompt.id === selected) ?? prompts[0];

  React.useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("berry.web.prompts") || "null");
      if (Array.isArray(saved)) setPrompts(saved);
    } catch {
      setPrompts(DEFAULT_PROMPTS);
    }
  }, []);

  const save = (next: SavedPrompt[]) => {
    setPrompts(next);
    localStorage.setItem("berry.web.prompts", JSON.stringify(next));
  };

  return (
    <ManagementPage
      title="Prompts & commands"
      description="A browser-synced library for reusable instructions and slash commands."
      eyebrow="Capabilities"
    >
      <div className="mgmt-split">
        <Section
          title="Library"
          actions={(
            <Button variant="ghost" size="icon" aria-label="Reset prompt library" onClick={() => save(DEFAULT_PROMPTS)}>
              <RotateCcw />
            </Button>
          )}
        >
          <div className="mgmt-select-list">
            {prompts.map((prompt) => (
              <Button key={prompt.id} aria-current={prompt.id === item?.id ? "true" : undefined} onClick={() => setSelected(prompt.id)}>
                <b>{prompt.name}</b>
                <code>{prompt.trigger}</code>
              </Button>
            ))}
          </div>
        </Section>
        {item ? (
          <Section title={item.name} description="Edit the natural-language body, preview it, or send it to the composer.">
            <label className="mgmt-field">
              Trigger
              <Input
                value={item.trigger}
                onChange={(event) => save(prompts.map((prompt) => prompt.id === item.id ? { ...prompt, trigger: event.currentTarget.value } : prompt))}
              />
            </label>
            <label className="mgmt-field">
              Prompt
              <Textarea
                value={item.body}
                onChange={(event) => save(prompts.map((prompt) => prompt.id === item.id ? { ...prompt, body: event.currentTarget.value } : prompt))}
              />
            </label>
            <div className="mgmt-form-actions">
              <Button variant="secondary" onClick={() => save(prompts.filter((prompt) => prompt.id !== item.id))}>
                <Trash2 />
                Delete
              </Button>
              <Button onClick={() => onUsePrompt(item.body)}>
                <Play />
                Use in composer
              </Button>
            </div>
          </Section>
        ) : null}
      </div>
    </ManagementPage>
  );
}
