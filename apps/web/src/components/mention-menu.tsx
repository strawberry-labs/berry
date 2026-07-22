import * as React from "react";
import { BUILT_IN_COMMANDS } from "@berry/shared";
import type { WebConfig } from "@/lib/config";
import { filterItems, type DetectedTrigger, type MentionItem, type MentionSection, type MentionTrigger } from "@/lib/mentions";
import type { PromptEditorHandle, PromptEditorMentions } from "./prompt-editor";

export interface MentionsController extends PromptEditorMentions {
  trigger: MentionTrigger | null;
  sections: MentionSection[];
  flatItems: MentionItem[];
  activeIndex: number;
  select: (item: MentionItem) => void;
  setActiveIndex: (index: number) => void;
}

export function useStaticMentions({
  editorRef,
  config,
  taskTitles,
  onSelectItem,
}: {
  editorRef: React.RefObject<PromptEditorHandle | null>;
  config: WebConfig;
  taskTitles: string[];
  onSelectItem?: ((item: MentionItem) => void) | undefined;
}): MentionsController {
  const [detected, setDetected] = React.useState<DetectedTrigger | null>(null);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const dismissKey = detected ? `${detected.trigger}:${detected.query}` : null;
  const trigger = detected && dismissed !== dismissKey ? detected.trigger : null;
  const query = detected?.query ?? "";

  const allItems = React.useMemo<Record<MentionTrigger, MentionItem[]>>(() => ({
    "@": [
      { id: "file:workspace", category: "folders", label: "workspace", description: "Cloud sandbox workspace root", value: "workspace" },
      { id: "file:README.md", category: "files", label: "README.md", description: "Attach by path once sandbox files are indexed", value: "README.md" },
    ],
    "/": BUILT_IN_COMMANDS.filter((command) => command.surfaces.includes("web")).map((command) => ({
      id: `cmd:${command.name}`,
      category: "commands",
      label: `/${command.name}`,
      description: command.description,
      value: command.name,
    })),
    "$": config.skills.map((skill) => ({
      id: `skill:${skill.id}`,
      category: "skills",
      label: skill.name,
      description: skill.description,
      value: skill.name,
    })),
    "#": taskTitles.map((title) => ({
      id: `task:${title}`,
      category: "sessions",
      label: title,
      description: "Recent task",
      value: title,
    })),
  } satisfies Record<MentionTrigger, MentionItem[]>), [config.skills, taskTitles]);

  const sections = React.useMemo<MentionSection[]>(() => {
    if (!trigger) return [];
    const title: Record<MentionTrigger, string> = { "@": "Files", "/": "Commands", $: "Skills", "#": "Tasks" };
    return [{ key: trigger, title: title[trigger], items: filterItems(allItems[trigger], query, 10) }];
  }, [allItems, query, trigger]);
  const flatItems = React.useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const open = trigger !== null && flatItems.length > 0;

  React.useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, flatItems.length - 1)));
  }, [flatItems.length]);

  const select = React.useCallback((item: MentionItem) => {
    if (!trigger) return;
    editorRef.current?.insertMention({
      id: item.id,
      category: item.category,
      label: item.label.replace(/^[/@$#]/, ""),
      markdown: `${trigger}${item.value}`,
    }, trigger);
    onSelectItem?.(item);
    setDetected(null);
    setDismissed(null);
  }, [editorRef, onSelectItem, trigger]);

  return {
    open,
    trigger,
    sections,
    flatItems,
    activeIndex,
    setActiveIndex,
    select,
    onDetectedChange: setDetected,
    moveActive: (delta) => setActiveIndex((index) => {
      if (flatItems.length === 0) return 0;
      return (index + delta + flatItems.length) % flatItems.length;
    }),
    selectActive: () => {
      const item = flatItems[activeIndex];
      if (!item) return false;
      select(item);
      return true;
    },
    dismiss: () => setDismissed(dismissKey),
  };
}

export function MentionMenu({ controller }: { controller: MentionsController }) {
  if (!controller.open) return null;
  let offset = 0;
  return (
    <div className="mentions-menu" role="listbox" data-testid="mention-menu">
      {controller.sections.map((section) => {
        const sectionOffset = offset;
        offset += section.items.length;
        return (
          <div key={section.key}>
            <div className="mentions-section-title">{section.title}</div>
            {section.items.map((item, index) => {
              const active = controller.activeIndex === sectionOffset + index;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="mention-row"
                  data-active={active}
                  onMouseEnter={() => controller.setActiveIndex(sectionOffset + index)}
                  onClick={() => controller.select(item)}
                  role="option"
                  aria-selected={active}
                >
                  <strong>{item.label}</strong>
                  {item.description ? <span>{item.description}</span> : null}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
