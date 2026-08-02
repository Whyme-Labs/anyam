/**
 * THROWAWAY PROTOTYPE — not production Anyam code.
 *
 * Question this prototype answers:
 * Can one local Workspace materialize several authorized Source Spaces as one
 * ordinary-looking filesystem while keeping each source boundary explicit,
 * taking automatic snapshots, showing a unified diff, undoing safely, and
 * making remote/local divergence a durable Conflict instead of silently
 * choosing a side?
 *
 * The reducer is intentionally dependency-free and pure. The terminal driver
 * is the disposable shell around it.
 */

export type SourceSpaceName = "community" | "commercial-core";
export type SnapshotKind = "initial" | "edit" | "sync" | "resolve" | "undo";
export type ConflictKind = "content";

export type FileState = {
  path: string;
  sourceSpace: SourceSpaceName;
  baseContent: string;
  content: string;
  remoteContent: string;
};

export type WorkspaceFrame = {
  files: Record<string, FileState>;
  baseSnapshots: Record<SourceSpaceName, string>;
  conflicts: Conflict[];
};

export type Snapshot = {
  id: string;
  kind: SnapshotKind;
  note: string;
  files: Record<string, string>;
  baseSnapshots: Record<SourceSpaceName, string>;
  conflicts: string[];
};

export type Operation = {
  id: string;
  kind: string;
  note: string;
};

export type Conflict = {
  id: string;
  kind: ConflictKind;
  path: string;
  sourceSpace: SourceSpaceName;
  baseContent: string;
  localContent: string;
  remoteContent: string;
};

export type PublishedRevision = {
  id: string;
  changeId: string;
  baseProjectRevision: string;
  sourceSnapshots: Record<SourceSpaceName, string>;
  changedPaths: string[];
};

export type AnyamState = {
  question: string;
  project: {
    name: string;
    view: string;
    workspaceId: string;
    changeId: string;
  };
  view: {
    profile: string;
    spaces: Array<{
      name: SourceSpaceName;
      mount: string;
      visibility: "public" | "private";
    }>;
  };
  sourceSpaces: Record<SourceSpaceName, {
    remoteSnapshot: string;
  }>;
  workspace: {
    baseProjectRevision: string;
    baseSnapshots: Record<SourceSpaceName, string>;
  };
  files: Record<string, FileState>;
  snapshots: Snapshot[];
  undoStack: WorkspaceFrame[];
  operations: Operation[];
  conflicts: Conflict[];
  publishedRevisions: PublishedRevision[];
  ids: {
    snapshot: number;
    operation: number;
    conflict: number;
    revision: number;
  };
  lastMessage: string;
  lastError: string | null;
};

export type Action =
  | { type: "edit"; path: string; content: string }
  | { type: "remote-edit"; sourceSpace: SourceSpaceName; path: string; content: string }
  | { type: "sync" }
  | { type: "undo" }
  | { type: "resolve"; path: string; choice: "local" | "remote" }
  | { type: "publish" }
  | { type: "check-mount"; sourceSpace: SourceSpaceName; mount: string }
  | { type: "invalid"; message: string }
  | { type: "reset" };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A tiny deterministic digest is enough for this interaction prototype. */
function digest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sourceSnapshot(
  sourceSpace: SourceSpaceName,
  files: Record<string, FileState>,
  remote = false,
): string {
  const sourceFiles = Object.values(files)
    .filter((file) => file.sourceSpace === sourceSpace)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${remote ? file.remoteContent : file.content}`)
    .join("\n");
  return `git:${sourceSpace}:${digest(sourceFiles)}`;
}

function projectRevision(snapshots: Record<SourceSpaceName, string>): string {
  return `project:${digest(Object.entries(snapshots).sort().join("\n"))}`;
}

function initialFile(
  path: string,
  sourceSpace: SourceSpaceName,
  content: string,
): FileState {
  return {
    path,
    sourceSpace,
    baseContent: content,
    content,
    remoteContent: content,
  };
}

function captureWorkspace(state: AnyamState): WorkspaceFrame {
  return {
    files: clone(state.files),
    baseSnapshots: clone(state.workspace.baseSnapshots),
    conflicts: clone(state.conflicts),
  };
}

function restoreWorkspace(state: AnyamState, frame: WorkspaceFrame): void {
  state.files = clone(frame.files);
  state.workspace.baseSnapshots = clone(frame.baseSnapshots);
  state.conflicts = clone(frame.conflicts);
}

function nextId(state: AnyamState, kind: keyof AnyamState["ids"], prefix: string): string {
  state.ids[kind] += 1;
  return `${prefix}-${String(state.ids[kind]).padStart(2, "0")}`;
}

function recordOperation(state: AnyamState, kind: string, note: string): void {
  state.operations.push({ id: nextId(state, "operation", "op"), kind, note });
}

function recordSnapshot(state: AnyamState, kind: SnapshotKind, note: string): void {
  const files = Object.fromEntries(
    Object.values(state.files).map((file) => [file.path, file.content]),
  );
  state.snapshots.push({
    id: nextId(state, "snapshot", "snap"),
    kind,
    note,
    files,
    baseSnapshots: clone(state.workspace.baseSnapshots),
    conflicts: state.conflicts.map((conflict) => conflict.id),
  });
}

function localMutation(
  state: AnyamState,
  kind: SnapshotKind,
  operationKind: string,
  note: string,
  mutate: (next: AnyamState) => void,
): AnyamState {
  const next = clone(state);
  next.undoStack.push(captureWorkspace(state));
  mutate(next);
  next.lastError = null;
  next.lastMessage = note;
  recordOperation(next, operationKind, note);
  recordSnapshot(next, kind, note);
  return next;
}

function rejected(state: AnyamState, message: string): AnyamState {
  const next = clone(state);
  next.lastError = message;
  next.lastMessage = "No state changed.";
  recordOperation(next, "rejected", message);
  return next;
}

function sourceSpaceForPath(state: AnyamState, path: string): SourceSpaceName | null {
  const matches = state.view.spaces
    .filter(({ mount }) => path === mount || path.startsWith(`${mount}/`))
    .sort((left, right) => right.mount.length - left.mount.length);
  return matches[0]?.name ?? null;
}

function findConflict(state: AnyamState, path: string): Conflict | undefined {
  return state.conflicts.find((conflict) => conflict.path === path);
}

function withRemoteSnapshot(state: AnyamState, sourceSpace: SourceSpaceName): void {
  state.sourceSpaces[sourceSpace].remoteSnapshot = sourceSnapshot(sourceSpace, state.files, true);
}

function changedPaths(state: AnyamState): string[] {
  return Object.values(state.files)
    .filter((file) => file.content !== file.baseContent)
    .map((file) => file.path)
    .sort();
}

function applyEdit(state: AnyamState, path: string, content: string): AnyamState {
  const existing = state.files[path];
  const sourceSpace = existing?.sourceSpace ?? sourceSpaceForPath(state, path);
  if (!sourceSpace) {
    return rejected(
      state,
      `Path is outside this Project View: ${path}. The Workspace can only edit mounted, authorized Source Spaces.`,
    );
  }

  return localMutation(
    state,
    "edit",
    "edit",
    `Edited ${path} in ${sourceSpace}; an automatic Snapshot was recorded.`,
    (next) => {
      if (existing) {
        next.files[path].content = content;
        return;
      }
      next.files[path] = {
        path,
        sourceSpace,
        baseContent: "",
        content,
        remoteContent: "",
      };
    },
  );
}

function applyRemoteEdit(
  state: AnyamState,
  sourceSpace: SourceSpaceName,
  path: string,
  content: string,
): AnyamState {
  const existing = state.files[path];
  if (!existing || existing.sourceSpace !== sourceSpace) {
    return rejected(
      state,
      `Remote simulator can only change a visible file in ${sourceSpace}; no private or undiscoverable path was materialized.`,
    );
  }
  const next = clone(state);
  next.files[path].remoteContent = content;
  withRemoteSnapshot(next, sourceSpace);
  next.lastError = null;
  next.lastMessage = `Simulated a remote commit in ${sourceSpace} touching ${path}. The Workspace is still offline from it.`;
  recordOperation(next, "remote-edit", next.lastMessage);
  return next;
}

function applySync(state: AnyamState): AnyamState {
  const remoteSpaces = (Object.keys(state.sourceSpaces) as SourceSpaceName[]).filter(
    (sourceSpace) =>
      state.sourceSpaces[sourceSpace].remoteSnapshot !==
      state.workspace.baseSnapshots[sourceSpace],
  );
  if (remoteSpaces.length === 0) {
    return rejected(state, "Workspace is already synchronized with its visible remote Snapshots.");
  }

  return localMutation(
    state,
    "sync",
    "sync",
    `Synchronized ${remoteSpaces.join(", ")}; divergent edits remain explicit Conflicts.`,
    (next) => {
      for (const file of Object.values(next.files)) {
        if (!remoteSpaces.includes(file.sourceSpace)) continue;
        const localChanged = file.content !== file.baseContent;
        const remoteChanged = file.remoteContent !== file.baseContent;
        if (!remoteChanged) continue;

        if (localChanged && file.content !== file.remoteContent) {
          if (!findConflict(next, file.path)) {
            next.ids.conflict += 1;
            next.conflicts.push({
              id: `conflict-${String(next.ids.conflict).padStart(2, "0")}`,
              kind: "content",
              path: file.path,
              sourceSpace: file.sourceSpace,
              baseContent: file.baseContent,
              localContent: file.content,
              remoteContent: file.remoteContent,
            });
          }
        }

        file.baseContent = file.remoteContent;
        if (!localChanged || file.content === file.remoteContent) {
          file.content = file.remoteContent;
        }
      }

      for (const sourceSpace of remoteSpaces) {
        next.workspace.baseSnapshots[sourceSpace] =
          next.sourceSpaces[sourceSpace].remoteSnapshot;
      }
      next.workspace.baseProjectRevision = projectRevision(next.workspace.baseSnapshots);
    },
  );
}

function applyUndo(state: AnyamState): AnyamState {
  if (state.undoStack.length === 0) {
    return rejected(state, "There is no local Workspace state to undo.");
  }
  const next = clone(state);
  const frame = next.undoStack.pop();
  if (!frame) return rejected(state, "There is no local Workspace state to undo.");
  restoreWorkspace(next, frame);
  next.lastError = null;
  next.lastMessage = "Undid the last local Workspace mutation by creating a new Snapshot; prior history remains visible.";
  recordOperation(next, "undo", next.lastMessage);
  recordSnapshot(next, "undo", next.lastMessage);
  return next;
}

function applyResolve(
  state: AnyamState,
  path: string,
  choice: "local" | "remote",
): AnyamState {
  const conflict = findConflict(state, path);
  if (!conflict) return rejected(state, `No unresolved Conflict exists for ${path}.`);

  return localMutation(
    state,
    "resolve",
    "resolve",
    `Resolved ${conflict.id} for ${path} by choosing the ${choice} version.`,
    (next) => {
      const file = next.files[path];
      file.baseContent = file.remoteContent;
      if (choice === "remote") file.content = file.remoteContent;
      next.conflicts = next.conflicts.filter((candidate) => candidate.id !== conflict.id);
    },
  );
}

function applyPublish(state: AnyamState): AnyamState {
  if (state.conflicts.length > 0) {
    return rejected(
      state,
      `Cannot publish while Conflicts remain: ${state.conflicts.map((conflict) => conflict.id).join(", ")}.`,
    );
  }
  const paths = changedPaths(state);
  if (paths.length === 0) return rejected(state, "Nothing changed in the Workspace to publish.");

  const next = clone(state);
  const sourceSnapshots = clone(next.workspace.baseSnapshots);
  for (const sourceSpace of Object.keys(sourceSnapshots) as SourceSpaceName[]) {
    if (next.files) sourceSnapshots[sourceSpace] = sourceSnapshot(sourceSpace, next.files);
  }
  const revisionId = nextId(next, "revision", "change-rev");
  next.publishedRevisions.push({
    id: revisionId,
    changeId: next.project.changeId,
    baseProjectRevision: next.workspace.baseProjectRevision,
    sourceSnapshots,
    changedPaths: paths,
  });
  next.lastError = null;
  next.lastMessage = `${revisionId} published for ${next.project.changeId}; canonical repositories were not written.`;
  recordOperation(next, "publish", next.lastMessage);
  return next;
}

function applyMountCheck(
  state: AnyamState,
  sourceSpace: SourceSpaceName,
  mount: string,
): AnyamState {
  const selected = state.view.spaces.find((space) => space.name === sourceSpace);
  if (!selected) {
    return rejected(state, "That Source Space is not available in this Project View.");
  }
  const collision = state.view.spaces.find(
    (space) =>
      space.name !== sourceSpace &&
      (space.mount === mount || space.mount.startsWith(`${mount}/`) || mount.startsWith(`${space.mount}/`)),
  );
  if (collision) {
    return rejected(
      state,
      `Mount collision: ${sourceSpace} at ${mount} overlaps ${collision.name} at ${collision.mount}. No materialization was changed.`,
    );
  }
  const next = clone(state);
  next.lastError = null;
  next.lastMessage = `Mount ${mount} is collision-free for ${sourceSpace}; this prototype does not rematerialize the filesystem.\n`;
  recordOperation(next, "check-mount", next.lastMessage);
  return next;
}

export function createInitialState(): AnyamState {
  const files: Record<string, FileState> = {
    "src/player/index.ts": initialFile(
      "src/player/index.ts",
      "community",
      "export function play(source: string) { return source; }\n",
    ),
    "src/player/controls.ts": initialFile(
      "src/player/controls.ts",
      "community",
      "export type Control = \"play\" | \"pause\";\n",
    ),
    "src/codec/index.ts": initialFile(
      "src/codec/index.ts",
      "commercial-core",
      "export function decode(frame: Uint8Array) { return frame; }\n",
    ),
    "src/codec/decoder.ts": initialFile(
      "src/codec/decoder.ts",
      "commercial-core",
      "export function decodePrivate(frame: Uint8Array) { return frame; }\n",
    ),
  };
  const baseSnapshots = {
    community: sourceSnapshot("community", files),
    "commercial-core": sourceSnapshot("commercial-core", files),
  } satisfies Record<SourceSpaceName, string>;
  const initial: AnyamState = {
    question:
      "Can one local Workspace compose authorized Source Spaces without turning boundaries, snapshots, undo, or conflicts into hidden behavior?",
    project: {
      name: "atlas-video-player",
      view: "commercial",
      workspaceId: "workspace-local",
      changeId: "change-video-controls",
    },
    view: {
      profile: "commercial",
      spaces: [
        { name: "community", mount: "src/player", visibility: "public" },
        { name: "commercial-core", mount: "src/codec", visibility: "private" },
      ],
    },
    sourceSpaces: {
      community: { remoteSnapshot: baseSnapshots.community },
      "commercial-core": { remoteSnapshot: baseSnapshots["commercial-core"] },
    },
    workspace: {
      baseProjectRevision: projectRevision(baseSnapshots),
      baseSnapshots,
    },
    files,
    snapshots: [],
    undoStack: [],
    operations: [],
    conflicts: [],
    publishedRevisions: [],
    ids: { snapshot: 0, operation: 0, conflict: 0, revision: 0 },
    lastMessage: "Workspace initialized from an exact Project Revision.",
    lastError: null,
  };
  recordSnapshot(initial, "initial", initial.lastMessage);
  recordOperation(initial, "open", initial.lastMessage);
  return initial;
}

export function reduce(state: AnyamState, action: Action): AnyamState {
  switch (action.type) {
    case "edit":
      return applyEdit(state, action.path, action.content);
    case "remote-edit":
      return applyRemoteEdit(state, action.sourceSpace, action.path, action.content);
    case "sync":
      return applySync(state);
    case "undo":
      return applyUndo(state);
    case "resolve":
      return applyResolve(state, action.path, action.choice);
    case "publish":
      return applyPublish(state);
    case "check-mount":
      return applyMountCheck(state, action.sourceSpace, action.mount);
    case "invalid":
      return rejected(state, action.message);
    case "reset":
      return createInitialState();
  }
}

export function fileStatus(file: FileState, conflicts: Conflict[]): string {
  const local = file.content === file.baseContent ? "clean" : "modified";
  const remote = file.remoteContent === file.baseContent ? "synced" : "remote-ahead";
  const conflict = conflicts.some((candidate) => candidate.path === file.path) ? "conflict" : "clear";
  return `${local}/${remote}/${conflict}`;
}

export function shortContent(content: string): string {
  const oneLine = content.replaceAll("\n", "\\n");
  return oneLine.length > 72 ? `${oneLine.slice(0, 69)}...` : oneLine;
}
