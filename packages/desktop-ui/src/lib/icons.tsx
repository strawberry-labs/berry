/**
 * Icon shim: the app uses lucide-style call sites (`<Search className="size-4" />`),
 * but the icons are Hugeicons. Each lucide name is re-exported here as a thin
 * component that renders the matching Hugeicons glyph, so files only need to
 * swap their import source from "@berry/desktop-ui/lib/icons" to this module.
 *
 * File-type icons for tool calls / the files panel are intentionally NOT here;
 * those use Berry's material-icon SVGs (see apps/desktop file-icons).
 */
import * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  AlertCircleIcon,
  Archive01Icon,
  ArchiveRestoreIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  AiBrain01Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  AtIcon,
  Attachment01Icon,
  BarChartIcon,
  BookOpen01Icon,
  BotIcon,
  BulbIcon,
  Camera01Icon,
  Cancel01Icon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CircleIcon as HugeCircleIcon,
  ChevronDownIcon as HugeChevronDown,
  ChevronLeftIcon as HugeChevronLeft,
  ChevronRightIcon as HugeChevronRight,
  ChevronUpIcon as HugeChevronUp,
  CodeSquareIcon,
  ComputerIcon,
  Copy01Icon,
  DashboardSpeed02Icon,
  Delete02Icon,
  DocumentCodeIcon,
  DotIcon,
  Download01Icon,
  Edit02Icon,
  File01Icon,
  Files01Icon,
  FlashIcon,
  Folder01Icon,
  Folder02Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  GitPullRequestIcon,
  GlobalIcon,
  GripVerticalIcon as HugeGripVertical,
  HandIcon,
  HashIcon,
  HelpCircleIcon,
  Image01Icon,
  ImageAddIcon,
  InformationCircleIcon,
  LayoutAlignBottomIcon,
  LayoutAlignLeftIcon,
  LayoutAlignRightIcon,
  LayoutAlignTopIcon,
  ListViewIcon,
  Loading03Icon,
  MagicWand01Icon,
  Message01Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  NoteEditIcon,
  PaintBoardIcon,
  PencilEdit02Icon as HugePencilEdit02Icon,
  PinIcon as HugePinIcon,
  PinOffIcon,
  Plug01Icon,
  PlusSignCircleIcon,
  PlusSignIcon,
  PreferenceHorizontalIcon,
  Refresh01Icon,
  Route01Icon,
  RocketIcon,
  Search01Icon,
  SecurityCheckIcon,
  SecurityIcon,
  ServerStack01Icon,
  Settings01Icon,
  SidebarBottomIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SourceCodeIcon,
  SquareIcon,
  Sun03Icon,
  TerminalIcon,
  Tick02Icon,
  UserMultipleIcon,
  Wrench01Icon,
  ZoomInAreaIcon,
} from "@hugeicons/core-free-icons";

/** Lucide-compatible prop surface so existing call sites type-check unchanged. */
export type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

/** Lucide-typed alias so `icon: LucideIcon` fields keep type-checking. */
export type LucideIcon = React.FC<IconProps>;

function make(icon: IconSvgElement): LucideIcon {
  const Icon: LucideIcon = ({ strokeWidth, size, ...props }) => (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={strokeWidth != null ? Number(strokeWidth) : 1.8}
      {...(size != null ? { size } : {})}
      {...(props as Record<string, unknown>)}
    />
  );
  return Icon;
}

/* ---- lucide name → Hugeicons glyph (both suffixed + unsuffixed spellings) ---- */

// shadcn primitives use the `…Icon` spellings.
export const XIcon = make(Cancel01Icon);
export const CheckIcon = make(Tick02Icon);
export const CircleCheckIcon = make(CheckmarkCircle02Icon);
export const InfoIcon = make(InformationCircleIcon);
export const Loader2Icon = make(Loading03Icon);
export const OctagonXIcon = make(AlertCircleIcon);
export const TriangleAlertIcon = make(Alert02Icon);
export const ChevronDownIcon = make(HugeChevronDown);
export const ChevronUpIcon = make(HugeChevronUp);
export const ChevronRightIcon = make(HugeChevronRight);
export const SearchIcon = make(Search01Icon);
export const PanelLeftIcon = make(SidebarLeftIcon);
export const CircleIcon = make(DotIcon);
export const ArrowDownIcon = make(ArrowDown01Icon);
export const GripVerticalIcon = make(HugeGripVertical);

// app + settings use the unsuffixed lucide spellings.
export const X = make(Cancel01Icon);
export const Check = make(Tick02Icon);
export const ChevronDown = make(HugeChevronDown);
export const ChevronUp = make(HugeChevronUp);
export const ChevronRight = make(HugeChevronRight);
export const ChevronLeft = make(HugeChevronLeft);
export const MoreHorizontal = make(MoreHorizontalIcon);
export const Ellipsis = make(MoreHorizontalIcon);
export const Search = make(Search01Icon);
export const PanelLeft = make(SidebarLeftIcon);
export const PanelRight = make(SidebarRightIcon);
export const PanelBottom = make(SidebarBottomIcon);
export const ArrowUp = make(ArrowUp01Icon);
export const ArrowUp02 = make(ArrowUp02Icon);
export const ArrowLeft = make(ArrowLeft01Icon);
export const ArrowLeft02 = make(ArrowLeft02Icon);
export const ArrowRight02 = make(ArrowRight02Icon);
export const ListTodo = make(CheckListIcon);
export const CircleHollow = make(HugeCircleIcon);
export const LayoutAlignLeft = make(LayoutAlignLeftIcon);
export const LayoutAlignRight = make(LayoutAlignRightIcon);
export const LayoutAlignTop = make(LayoutAlignTopIcon);
export const LayoutAlignBottom = make(LayoutAlignBottomIcon);
export const CirclePlus = make(PlusSignCircleIcon);
export const Plus = make(PlusSignIcon);
export const FolderOpen = make(FolderOpenIcon);
export const Folder = make(Folder01Icon);
export const Folder02 = make(Folder02Icon);
export const FolderPlus = make(FolderAddIcon);
export const Globe = make(GlobalIcon);
export const Palette = make(PaintBoardIcon);
export const ZoomIn = make(ZoomInAreaIcon);
export const CircleHelp = make(HelpCircleIcon);
export const Camera = make(Camera01Icon);
export const Files = make(Files01Icon);
export const GitPullRequest = make(GitPullRequestIcon);
export const RefreshCw = make(Refresh01Icon);
export const SquareTerminal = make(TerminalIcon);
export const Archive = make(Archive01Icon);
export const ArchiveRestore = make(ArchiveRestoreIcon);
export const Copy = make(Copy01Icon);
export const GaugeIcon = make(DashboardSpeed02Icon);
export const GitBranch = make(GitBranchIcon);
export const GitFork = make(GitForkIcon);
export const Pin = make(HugePinIcon);
export const PinOff = make(PinOffIcon);
export const Pencil = make(Edit02Icon);
export const PencilLine = make(Edit02Icon);
export const PencilEdit02Icon = make(HugePencilEdit02Icon);
export const Trash2 = make(Delete02Icon);
export const BookOpen = make(BookOpen01Icon);
export const FileDown = make(Download01Icon);
export const Lightbulb = make(BulbIcon);
export const MessageSquare = make(Message01Icon);
export const Users = make(UserMultipleIcon);
export const Brain = make(AiBrain01Icon);
export const Bot = make(BotIcon);
export const Wrench = make(Wrench01Icon);
export const ListCollapse = make(ListViewIcon);
export const LayoutList = make(ListViewIcon);
export const Settings = make(Settings01Icon);
export const Wand2 = make(MagicWand01Icon);
export const WandSparkles = make(MagicWand01Icon);
export const Monitor = make(ComputerIcon);
export const Moon = make(Moon02Icon);
export const Sun = make(Sun03Icon);
export const Rocket = make(RocketIcon);
export const ShieldQuestion = make(SecurityIcon);
export const ShieldCheck = make(SecurityCheckIcon);
export const ChartColumn = make(BarChartIcon);
export const Route = make(Route01Icon);
// The queue treatment uses a named semantic alias so call sites describe the
// action rather than the underlying glyph. Hugeicons' free set does not ship
// a dedicated Queue01 asset; Route01 is its closest directional queue mark.
export const Queue01Icon = make(Route01Icon);
export const AtSign = make(AtIcon);
export const Hand = make(HandIcon);
export const Hash = make(HashIcon);
export const ImagePlus = make(ImageAddIcon);
export const NotebookPen = make(NoteEditIcon);
export const Paperclip = make(Attachment01Icon);
export const SlashSquare = make(CodeSquareIcon);
export const Square = make(SquareIcon);
export const Zap = make(FlashIcon);
export const Plug = make(Plug01Icon);
export const CodeXml = make(SourceCodeIcon);
export const Server = make(ServerStack01Icon);
export const SlidersHorizontal = make(PreferenceHorizontalIcon);

// Generic doc icons still referenced outside the file-type icon system.
export const FileText = make(File01Icon);
export const FileCode = make(DocumentCodeIcon);
export const FileImage = make(Image01Icon);
export const FileJson = make(File01Icon);
export const File = make(File01Icon);
