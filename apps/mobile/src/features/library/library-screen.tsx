import * as React from "react";
import { Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { StoredFile } from "@berry/shared";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { FileImage, Files, FileText, FolderOpen, Folder, TriangleAlertIcon, X } from "../../ui/icons";
import { Menu, type MenuItem } from "../../ui/menu";
import { Progress, Spinner } from "../../ui/primitives";
import { Screen } from "../../ui/screen";
import { Text } from "../../ui/text";
import { pickDocuments, pickPhotos } from "../composer/attachments";
import { useWorkspaces } from "../data/shell-data";
import { TopBar } from "../shell/top-bar";
import { useAuthHeaders } from "../page-kit/auth-headers";
import { actionErrorMessage } from "../page-kit/errors";
import { Upload } from "../../ui/icons";
import { CapabilityUnavailable, PageHeader, SearchField, SelectField, UnderlineTabs, useCapabilityAvailable, useScrollTitle } from "../page-kit/page-kit";
import { FileOpenSheet } from "./file-open-sheet";
import { ImageViewer } from "./image-viewer";
import { LibraryCard } from "./library-card";
import { useLibraryFiles, useLibraryUploads, useRemoveFromLibrary, type LibraryUpload } from "./library-data";
import { isImageFile, libraryItemsForTab, libraryTabCounts, parseLibraryTab, projectFilterWorkspaces, type LibraryTab } from "./library-model";
import { useFileOpener } from "./use-file-opener";

const SEARCH_DEBOUNCE_MS = 220;
const GUTTER = 16;
const GAP = 9;

const UPLOAD_MENU: MenuItem[] = [
  { id: "library", title: "Photo Library", systemImage: "photo.on.rectangle" },
  { id: "camera", title: "Take Photo", systemImage: "camera" },
  { id: "files", title: "Choose Files", systemImage: "folder" },
];

/** The web Library (/library/$tab): every upload and saved sandbox file, searchable and filterable. */
export function LibraryScreen() {
  const available = useCapabilityAvailable("library");
  const scroll = useScrollTitle();
  return (
    <Screen edges={["top"]}>
      {available ? <LibraryBody scroll={scroll} /> : (
        <>
          <TopBar title="Library" />
          <CapabilityUnavailable feature="Library" />
        </>
      )}
    </Screen>
  );
}

function LibraryBody({ scroll }: { scroll: ReturnType<typeof useScrollTitle> }) {
  const { colors, layout } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = React.useState<LibraryTab>(() => parseLibraryTab(params.tab));
  React.useEffect(() => { if (params.tab) setTab(parseLibraryTab(params.tab)); }, [params.tab]);

  const [searchInput, setSearchInput] = React.useState("");
  const search = useDebouncedValue(searchInput.trim(), SEARCH_DEBOUNCE_MS);
  const workspaces = useWorkspaces();
  const projects = React.useMemo(() => projectFilterWorkspaces(workspaces.data ?? []), [workspaces.data]);
  const [projectId, setProjectId] = React.useState("");
  React.useEffect(() => {
    if (projectId && workspaces.data && !projects.some((project) => project.id === projectId)) setProjectId("");
  }, [projectId, projects, workspaces.data]);

  const files = useLibraryFiles({ workspaceId: projectId, search });
  const visible = React.useMemo(() => libraryItemsForTab(files.items, tab), [files.items, tab]);
  const counts = React.useMemo(() => libraryTabCounts(files.items), [files.items]);
  const headers = useAuthHeaders();
  const removeFile = useRemoveFromLibrary().mutate;
  const uploads = useLibraryUploads();
  const opener = useFileOpener();
  const startOpen = opener.start;
  const [viewing, setViewing] = React.useState<StoredFile | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try { await files.refetch(); } finally { setRefreshing(false); }
  }, [files]);

  const pick = React.useCallback(async (source: string) => {
    try {
      const picked = source === "files" ? await pickDocuments() : await pickPhotos(source === "camera" ? "camera" : "library");
      if (picked.length > 0) uploads.start(picked);
    } catch (cause) {
      Alert.alert("Couldn't add files", actionErrorMessage(cause, "Try again."));
    }
  }, [uploads]);

  const confirmRemove = React.useCallback((file: StoredFile) => {
    Alert.alert(
      `Remove ${file.name} from Library?`,
      "The file will remain in tasks and projects where it is used. Storage is cleaned up after nothing references it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove from Library",
          style: "destructive",
          onPress: () => removeFile(file, {
            onSuccess: () => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setViewing((current) => current?.id === file.id ? null : current);
            },
            onError: (cause) => Alert.alert("Unable to remove the file from Library", actionErrorMessage(cause, "Try again.")),
          }),
        },
      ],
    );
  }, [removeFile]);

  const open = React.useCallback((file: StoredFile) => {
    if (isImageFile(file)) setViewing(file);
    else void startOpen(file);
  }, [startOpen]);

  const onMenu = React.useCallback((file: StoredFile, action: string) => {
    if (action === "open") open(file);
    else if (action === "share") void startOpen(file);
    else if (action === "remove") confirmRemove(file);
  }, [confirmRemove, open, startOpen]);

  const renderItem = React.useCallback<ListRenderItem<StoredFile>>(({ item }) => (
    <View style={styles.cell}>
      <LibraryCard file={item} headers={headers} onOpen={open} onMenu={onMenu} />
    </View>
  ), [headers, onMenu, open]);

  const loadingInitial = files.isPending;
  const loadError = files.isError && !files.data;
  const background = files.isFetching && !refreshing && !files.isFetchingNextPage && !loadingInitial;

  const header = (
    <View style={styles.header}>
      <PageHeader title="Library" description="Uploads and files saved from Berry sandboxes appear here automatically." />
      <View style={styles.filters}>
        <SearchField value={searchInput} onChangeText={setSearchInput} placeholder="Search files" style={styles.search} />
        {projects.length > 0 ? (
          <SelectField
            compact
            icon={Folder}
            value={projectId}
            onChange={setProjectId}
            accessibilityLabel="Filter files by project"
            options={[{ value: "", label: "All projects" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
            style={styles.project}
          />
        ) : null}
      </View>
      <UnderlineTabs
        accessibilityLabel="Library file type"
        value={tab}
        onChange={setTab}
        items={[
          { value: "all", label: "All", icon: Files, count: counts.all },
          { value: "images", label: "Images", icon: FileImage, count: counts.images },
          { value: "documents", label: "Documents", icon: FileText, count: counts.documents },
        ]}
      />
      {uploads.uploads.length > 0 ? (
        <View style={styles.uploads}>
          {uploads.uploads.map((upload) => <UploadRow key={upload.id} upload={upload} onCancel={() => uploads.cancel(upload)} />)}
        </View>
      ) : null}
    </View>
  );

  const empty = loadingInitial ? (
    <View style={styles.status} accessibilityLabel="Loading library" accessibilityState={{ busy: true }}><Spinner size="large" /></View>
  ) : loadError ? (
    <LibraryStatus title="The library could not be loaded" detail={actionErrorMessage(files.error, "Unable to load the library")} action={<Button size="sm" label="Try again" onPress={() => void files.refetch()} />} />
  ) : (
    <LibraryStatus
      title={search ? "No matching files" : tab === "all" ? "No files yet" : tab === "images" ? "No images yet" : "No documents yet"}
      detail={search ? "Try a different file name or clear the search." : "Upload a file in a task or ask Berry to create one. It will show up here."}
      action={search ? undefined : (
        <Menu items={UPLOAD_MENU} onSelect={(id) => void pick(id)} title="Upload to Library">
          <View accessible accessibilityRole="button" accessibilityLabel="Upload files" style={[styles.uploadAction, { borderColor: colors.borderStrong, borderRadius: layout.radius }]}>
            <Upload size={14} color={colors.textPrimary} />
            <Text variant="secondary" weight="medium">Upload files</Text>
          </View>
        </Menu>
      )}
    />
  );

  const footer = files.isFetchingNextPage ? (
    <View style={styles.footer}><Spinner /></View>
  ) : files.isFetchNextPageError ? (
    <View style={styles.footer}>
      <Text variant="secondary" tone="tertiary">Unable to load more files</Text>
      <Button variant="outline" size="sm" label="Try again" onPress={() => void files.fetchNextPage()} />
    </View>
  ) : null;

  return (
    <>
      <TopBar
        title={scroll.titleVisible ? "Library" : undefined}
        trailing={(
          <>
            {background ? <View style={styles.topAction} accessibilityLabel="Updating files"><Spinner /></View> : null}
            <Menu items={UPLOAD_MENU} onSelect={(id) => void pick(id)} title="Upload to Library">
              <View accessible accessibilityRole="button" accessibilityLabel="Upload to Library" style={styles.topAction}>
                <Upload size={18} color={colors.textSecondary} />
              </View>
            </Menu>
          </>
        )}
      />
      <FlashList
        data={loadError ? [] : visible}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        numColumns={2}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        onEndReached={() => {
          if (files.hasNextPage && !files.isFetchingNextPage && !files.isFetchNextPageError) void files.fetchNextPage();
        }}
        onEndReachedThreshold={0.6}
        onScroll={scroll.onScroll}
        scrollEventThrottle={32}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: GUTTER - GAP / 2, paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.textTertiary} />}
      />
      <ImageViewer file={viewing} onClose={() => setViewing(null)} />
      <FileOpenSheet
        state={opener.state}
        onCancel={opener.cancel}
        onRetry={() => { if (opener.state) void opener.start(opener.state.file); }}
      />
    </>
  );
}

function UploadRow({ upload, onCancel }: { upload: LibraryUpload; onCancel: () => void }) {
  const { colors, layout } = useTheme();
  const failed = upload.state === "failed";
  return (
    <View style={[styles.uploadRow, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: layout.radius }]}>
      {failed ? <TriangleAlertIcon size={16} color={colors.danger} /> : <Spinner />}
      <View style={styles.uploadBody}>
        <Text variant="secondary" weight="medium" numberOfLines={1}>{upload.name}</Text>
        {failed
          ? <Text variant="meta" tone="danger" numberOfLines={2}>{upload.error ?? "Upload failed."}</Text>
          : <Progress value={upload.progress * 100} accessibilityLabel={`Uploading ${upload.name}`} />}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={failed ? `Dismiss ${upload.name}` : `Cancel uploading ${upload.name}`} hitSlop={10} onPress={onCancel} style={styles.uploadCancel}>
        <X size={14} color={colors.textTertiary} />
      </Pressable>
    </View>
  );
}

function LibraryStatus({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.status}>
      <FolderOpen size={26} color={colors.textTertiary} />
      <Text variant="body" weight="medium" style={styles.center}>{title}</Text>
      <Text variant="secondary" tone="tertiary" style={[styles.center, styles.detail]}>{detail}</Text>
      {action ? <View style={styles.statusAction}>{action}</View> : null}
    </View>
  );
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, value]);
  return debounced;
}

const styles = StyleSheet.create({
  header: { gap: 16, paddingHorizontal: GAP / 2, paddingBottom: 14 },
  filters: { flexDirection: "row", alignItems: "center", gap: 8 },
  search: { flex: 1 },
  project: { maxWidth: 150, flexShrink: 1 },
  uploads: { gap: 6 },
  uploadRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingLeft: 12, paddingRight: 6, borderWidth: StyleSheet.hairlineWidth },
  uploadBody: { flex: 1, minWidth: 0, gap: 6 },
  uploadCancel: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  cell: { flex: 1, paddingHorizontal: GAP / 2, paddingBottom: GAP },
  status: { minHeight: 280, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 24 },
  center: { textAlign: "center" },
  detail: { maxWidth: 320 },
  statusAction: { marginTop: 8 },
  uploadAction: { flexDirection: "row", alignItems: "center", gap: 6, height: 32, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth * 2 },
  footer: { alignItems: "center", gap: 8, paddingVertical: 18 },
  topAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
