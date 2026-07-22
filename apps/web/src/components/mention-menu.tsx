import * as React from "react";
import { BUILT_IN_COMMANDS } from "@berry/shared";
import { AtSign, FileText, Folder, Hash, SlashSquare, Wand2 } from "@berry/desktop-ui/lib/icons";
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
    // A changed trigger or filter starts at the first live match, matching
    // native command palettes rather than retaining a stale row index.
    setActiveIndex(0);
  }, [query, trigger]);

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
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [side, setSide] = React.useState<"top" | "bottom">("top");

  React.useLayoutEffect(() => {
    if (!controller.open) return;
    const place = () => {
      const menu = menuRef.current;
      const editor = document.querySelector<HTMLElement>(".berry-prompt-editor");
      if (!menu || !editor) return;
      const editorBounds = editor.getBoundingClientRect();
      const menuHeight = Math.min(menu.offsetHeight || 0, 320);
      const spaceAbove = editorBounds.top;
      const spaceBelow = window.innerHeight - editorBounds.bottom;
      setSide(spaceAbove >= menuHeight + 8 || spaceAbove >= spaceBelow ? "top" : "bottom");
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [controller.flatItems.length, controller.open, controller.trigger]);

  React.useEffect(() => {
    if (!controller.open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || menuRef.current?.contains(target)) return;
      if (target.closest('[data-testid="composer-input"], [data-testid="message-editor-input"]')) return;
      controller.dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [controller.dismiss, controller.open]);

  React.useEffect(() => {
    if (!controller.open) return;
    // Keyboard navigation must move the viewport with the highlighted item;
    // mouse hover already has a naturally visible target. `nearest` keeps the
    // menu stable until the active row would otherwise leave the scrollport.
    menuRef.current
      ?.querySelector<HTMLButtonElement>('.mention-row[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [controller.activeIndex, controller.open]);

  if (!controller.open) return null;

  let offset = 0;
  return (
    <div ref={menuRef} className="mentions-menu" role="listbox" data-testid="mention-menu" data-trigger={controller.trigger} data-side={side}>
      {controller.sections.map((section) => {
        const sectionOffset = offset;
        offset += section.items.length;
        return (
          <div key={section.key} role="group" aria-label={section.title}>
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
                  <MentionRowIcon category={item.category} />
                  <strong className="mention-row-label">{item.label}</strong>
                  {item.description ? <span className="mention-row-description">{item.description}</span> : null}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function MentionRowIcon({ category }: { category: MentionItem["category"] }) {
  if (category === "folders") return <Folder />;
  if (category === "files") return <FileText />;
  if (category === "commands") return <SlashSquare />;
  if (category === "skills") return <Wand2 />;
  if (category === "sessions") return <Hash />;
  return <AtSign />;
}
