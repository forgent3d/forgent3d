export {};

type PreviewFormat = 'BREP' | 'STL' | 'MJCF' | string;

type AicadModel = {
  name: string;
  parts?: Array<{
    name: string;
    sourceFile?: string;
    stlFile?: string;
    hasStl?: boolean;
    stlUrl?: string;
    [key: string]: unknown;
  }>;
  type?: string;
  sourceFile?: string;
  previewUrl?: string;
  paramsUrl?: string;
  format?: PreviewFormat;
  [key: string]: unknown;
};

type AicadProjectMeta = {
  path: string;
  kernel: string;
  kernelLabel: string;
  sourceFile: string;
  sourceFiles: string[];
  previewFormat: PreviewFormat;
  runner: string;
  kernels: Array<{ id: string; [key: string]: unknown }>;
};

type AicadModelsPayload = {
  models: AicadModel[];
  active: string | null;
};

type AicadParamsPayload = {
  model: string;
  part?: string | null;
  label?: string;
  exists?: boolean;
  text: string;
};

type AicadTerminalCreatePayload = {
  termId: string;
  cols?: number;
  rows?: number;
  message?: string;
  [key: string]: unknown;
};

type AicadEventHandler = (message: {
  type: string;
  payload?: unknown;
}) => void;

type AicadApi = {
  dialogConfirm(opts: { title: string; message: string; confirmLabel?: string; cancelLabel?: string }): Promise<boolean>;
  chooseDirectory(): Promise<string | null>;
  createProject(parentDir: string, projectName: string, kernel: string): Promise<string>;
  openProject(projectPath?: string | null): Promise<string | null>;
  projectMeta(): Promise<AicadProjectMeta | null>;
  rebuild(): Promise<boolean>;
  revealInFolder(): Promise<void>;

  listModels(): Promise<AicadModelsPayload>;
  selectModel(name: string): Promise<string | undefined>;
  createModel(payload: {
    name: string;
    description?: string;
    template?: string;
    params?: Record<string, number | string | boolean>;
  } | string, description?: string): Promise<{ name: string; path: string; parts: string[] }>;
  rebuildModel(name: string): Promise<boolean>;
  rebuildAllModels(): Promise<{ ok: boolean; results: Array<{ name: string; ok: boolean; error?: string }> }>;
  revealModel(name: string): Promise<void>;
  deleteModel(name: string): Promise<void>;
  exportModel(name: string, format: string): Promise<unknown>;
  ensureModelPartStl(model: string, part: string): Promise<{ model: string; part: string; path: string; url: string }>;
  getParams(target: string | { model: string; part?: string | null; label?: string }): Promise<AicadParamsPayload>;
  saveParams(target: string | { model: string; part?: string | null; label?: string }, text: string): Promise<AicadParamsPayload>;

  notifyPartLoaded(payload: unknown): Promise<void>;

  mcpStatus(): Promise<unknown>;
  mcpTestListParts(): Promise<unknown>;
  pythonStatus(): Promise<unknown>;
  getLanguage(): Promise<string>;
  setLanguage(language: string): Promise<string>;

  terminalCreate(agent: string, projectPath: string, cols: number, rows: number): Promise<AicadTerminalCreatePayload>;
  terminalWrite(termId: string, data: string): Promise<void>;
  terminalResize(termId: string, cols: number, rows: number): Promise<void>;
  terminalKill(termId: string): Promise<void>;
  clipboardReadText(): Promise<string>;
  clipboardWriteText(text: string): Promise<boolean>;
  clipboardHasImage(): Promise<boolean>;

  /** Forgent3D agent UI (cad-agent); `baseUrl` defaults from `AICAD_FORGENT3D_URL` or legacy `AICAD_NEXT_AGENT_URL`. */
  agentOpenNext(projectPath: string, baseUrl?: string, openExternal?: boolean): Promise<{ url: string; preloadUrl?: string }>;
  agentBridgeInfo(): Promise<{
    version: string;
    preloadUrl?: string;
    projectPath: string;
    language: string;
    capabilities: Record<string, boolean>;
  }>;

  onEvent(handler: AicadEventHandler): () => void;
};

declare global {
  interface Window {
    aicad: AicadApi;
  }
}
