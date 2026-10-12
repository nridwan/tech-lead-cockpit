// Mirrors connector/figma.ts: Cockpit reads Figma through the REST API (token in the Keychain) and
// writes screenshots plus on-screen text into the draft's AI workspace under figma/.

export interface FigmaUser {
  id: string;
  handle: string;
  email?: string;
}

export interface FigmaStatus {
  configured: boolean;
  tokenPresent: boolean;
  user?: FigmaUser;
  error?: string;
}

export interface FigmaScreen {
  /** Figma node id (1:2). */
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  /** Section, group or frame it sits in (for display). */
  parent?: string;
}

export interface FigmaScreenList {
  fileKey: string;
  nodeId?: string;
  fileName: string;
  /** Name of the linked node (the file name for a whole-file link). */
  nodeName: string;
  version: string;
  lastModified: string;
  screens: FigmaScreen[];
  /** Preselected screen ids. */
  selected: string[];
  /** The link has no node-id: screens are every page's top-level frames, none preselected. */
  wholeFile?: boolean;
}

export interface FigmaFetchedScreen {
  id: string;
  name: string;
  width: number;
  height: number;
  /** PNG file name in figma/<set>/ (missing when Figma could not render the node). */
  image?: string;
  textCount: number;
}

export interface FigmaFetchedSet {
  /** Folder name under figma/: <fileKey>_<node>. */
  id: string;
  url: string;
  title?: string;
  fileKey: string;
  nodeId?: string;
  fileName: string;
  /** Figma file version at fetch time. */
  version: string;
  lastModified: string;
  fetchedAt: string;
  screens: FigmaFetchedScreen[];
  /** Set by the version check: the Figma file changed after this fetch. */
  stale?: boolean;
  currentVersion?: string;
}
