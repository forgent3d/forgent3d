export {};

type PreviewFormat = 'BREP' | 'STL' | 'MJCF' | string;

type AicadPart = {
  name: string;
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

type AicadPartsPayload = {
  parts: AicadPart[];
  active: string | null;
};

type AicadParamsPayload = {
  model: string;
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
  chooseDirectory(): Promise<string | null>;
  createProject(parentDir: string, projectName: string, kernel: string): Promise<string>;
  openProject(projectPath?: string | null): Promise<string | null>;
  projectMeta(): Promise<AicadProjectMeta | null>;
  rebuild(): Promise<boolean>;
  revealInFolder(): Promise<void>;

  listParts(): Promise<AicadPartsPayload>;
  selectPart(name: string): Promise<string | undefined>;
  rebuildPart(name: string): Promise<boolean>;
  revealPart(name: string): Promise<void>;
  exportPart(name: string, format: string): Promise<unknown>;
  getParams(name: string): Promise<AicadParamsPayload>;
  saveParams(name: string, text: string): Promise<AicadParamsPayload>;

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

  onEvent(handler: AicadEventHandler): () => void;
};

declare global {
  interface Window {
    aicad: AicadApi;
  }
}
