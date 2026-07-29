import * as React from "react";
import { Play, RotateCcw, Save, Trash2 } from "lucide-react";
import {
  Button,
  Input,
  ManagementPage,
  Section,
  SuccessMessage,
  Textarea,
} from "./management-primitives";
import { useLocalSetting } from "./management-context";

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
  const [instructions, setInstructions] = useLocalSetting("berry.web.customInstructions", "");
  const [instructionDraft, setInstructionDraft] = React.useState("");
  const [instructionsDirty, setInstructionsDirty] = React.useState(false);
  const [instructionsSaved, setInstructionsSaved] = React.useState(false);
  const item = prompts.find((prompt) => prompt.id === selected) ?? prompts[0];

  React.useEffect(() => {
    if (!instructionsDirty) setInstructionDraft(instructions);
  }, [instructions, instructionsDirty]);

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
      title="Instructions & prompts"
      description="Set instructions for new conversations and keep reusable prompts and slash commands."
      eyebrow="Personalization"
    >
      <Section title="Custom instructions" description="Applied to new conversations; existing task history is unchanged.">
        <Textarea
          className="min-h-32 resize-y"
          value={instructionDraft}
          onChange={(event) => {
            setInstructionDraft(event.currentTarget.value);
            setInstructionsDirty(event.currentTarget.value !== instructions);
            setInstructionsSaved(false);
          }}
          placeholder="Tell Berry how you prefer to work…"
          aria-label="Custom instructions"
        />
        {instructionsDirty ? (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 rounded-lg border border-border bg-muted/40 p-2.5">
            <span className="mr-auto text-xs font-medium text-muted-foreground">Unsaved changes</span>
            <Button variant="secondary" onClick={() => { setInstructionDraft(instructions); setInstructionsDirty(false); }}>Discard</Button>
            <Button onClick={() => { setInstructions(instructionDraft); setInstructionsDirty(false); setInstructionsSaved(true); }}><Save />Save changes</Button>
          </div>
        ) : null}
        {instructionsSaved ? <SuccessMessage>Instructions saved in this browser.</SuccessMessage> : null}
      </Section>
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
        <Section
          title="Library"
          actions={(
            <Button variant="ghost" size="icon" aria-label="Reset prompt library" onClick={() => save(DEFAULT_PROMPTS)}>
              <RotateCcw />
            </Button>
          )}
        >
          <div className="grid gap-1">
            {prompts.map((prompt) => (
              <Button className="h-auto justify-between gap-3 px-3 py-2 text-left" variant={prompt.id === item?.id ? "secondary" : "ghost"} key={prompt.id} aria-current={prompt.id === item?.id ? "true" : undefined} onClick={() => setSelected(prompt.id)}>
                <b className="truncate text-sm font-medium">{prompt.name}</b>
                <code className="text-xs text-muted-foreground">{prompt.trigger}</code>
              </Button>
            ))}
          </div>
        </Section>
        {item ? (
          <Section title={item.name} description="Edit the natural-language body, preview it, or send it to the composer.">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span>Trigger</span>
              <Input
                value={item.trigger}
                onChange={(event) => save(prompts.map((prompt) => prompt.id === item.id ? { ...prompt, trigger: event.currentTarget.value } : prompt))}
              />
            </label>
            <label className="mt-4 grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span>Prompt</span>
              <Textarea
                value={item.body}
                onChange={(event) => save(prompts.map((prompt) => prompt.id === item.id ? { ...prompt, body: event.currentTarget.value } : prompt))}
              />
            </label>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
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
