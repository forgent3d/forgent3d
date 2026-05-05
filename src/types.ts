import type * as THREE from 'three';

export type PreviewMode = 'solid' | 'xray' | 'wireframe';
export type SectionAxis = 'x' | 'y' | 'z';
export type ViewKey = 'iso' | 'front' | 'back' | 'side' | 'right' | 'left' | 'top' | 'bottom' | 'custom';

export type Vec3Tuple = [number, number, number];

export type BoundsRange = {
  min: number;
  max: number;
};

export type AxisRanges = Record<SectionAxis, BoundsRange>;

export type SectionState = {
  enabled: boolean;
  axis: SectionAxis;
  normalized: number;
};

export type SectionPlaneInfo = {
  enabled: boolean;
  axis: SectionAxis;
  coord: number;
  ranges: AxisRanges;
};

export type BBoxInfo = {
  min: Vec3Tuple;
  max: Vec3Tuple;
  size: Vec3Tuple;
  center: Vec3Tuple;
};

export type FaceInfo = {
  index: number;
  centroid: Vec3Tuple;
  normal: Vec3Tuple;
};

export type PartInfo = {
  faceCount: number;
  bbox: BBoxInfo;
  faces: FaceInfo[];
};

export type LoadModelFormat = 'BREP' | 'STL' | 'MJCF';

export type LoadModelOptions = {
  format?: LoadModelFormat | string;
  paramsUrl?: string;
  preserveView?: boolean;
};

export type LogHandler = (message: string, level?: string) => void;

export type MaterialSpec = {
  preset?: string;
  material?: string;
  color?: THREE.ColorRepresentation;
  metalness?: number;
  roughness?: number;
  envMapIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  [key: string]: unknown;
};

export type MaterialParams = {
  __viewer?: {
    materials?: MaterialConfig;
  };
  viewer?: {
    materials?: MaterialConfig;
  };
  [key: string]: unknown;
};

export type MaterialConfig = {
  default?: MaterialSpec | THREE.ColorRepresentation;
  parts?: Record<string, MaterialSpec | THREE.ColorRepresentation>;
};

export type MaterialPart = {
  id: string | number;
  name?: string;
  aliases?: Array<string | number>;
  index?: number;
  materialIndex?: number;
};

export type ViewSpec = {
  key?: ViewKey | string;
  dir?: THREE.Vector3 | Vec3Tuple | number[];
  up?: THREE.Vector3 | Vec3Tuple | number[];
};

export type SnapshotOptions = {
  view?: string;
  mode?: PreviewMode;
  previewMode?: PreviewMode;
  maxEdge?: number;
  maxWidth?: number;
  axes?: boolean;
};

export type SnapshotRenderer = (mimeType?: string, options?: SnapshotOptions) => string | null;

export type Viewer = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  mountViewCube(hostEl: HTMLElement | null): void;
  setViewCubeEnabled(enabled: boolean): void;
  setPreviewMode(mode: PreviewMode | string): PreviewMode;
  getPreviewMode(): PreviewMode;
  loadBrep(url: string, onLog?: LogHandler, opts?: LoadModelOptions): Promise<PartInfo>;
  loadStl(url: string, onLog?: LogHandler, opts?: LoadModelOptions): Promise<PartInfo>;
  loadMjcf(url: string, paramsUrl?: string, onLog?: LogHandler, opts?: LoadModelOptions): Promise<PartInfo>;
  loadModel(url: string, onLog?: LogHandler, opts?: LoadModelOptions): Promise<PartInfo>;
  snapshot: SnapshotRenderer;
  setView(viewInput?: ViewSpec | string, opts?: { distance?: number }): ViewKey | string;
  fitView(viewInput?: ViewSpec | string): ViewKey | string;
  cycleView(): ViewKey | string;
  setSectionEnabled(enabled: boolean): void;
  setSectionNormalized(normalized: number): void;
  setSectionAxis(axis: SectionAxis | string): void;
  resetSection(): void;
  getSectionState(): SectionState;
  refreshPreview(): void;
  setMaterialParams(params?: MaterialParams): void;
  setPartMaterial(partKey: string | number, config: MaterialSpec | THREE.ColorRepresentation): boolean;
  setPartMaterialColor(partKey: string | number, color: THREE.ColorRepresentation): boolean;
  setPartMaterialColors(colorsByPart: Record<string, THREE.ColorRepresentation>): void;
  getMaterialParts(): Array<MaterialPart & { color: string | null }>;
  getPartMaterialState(): Record<string, MaterialSpec>;
  getCurrentView(): ViewKey | string;
  hasModel(): boolean;
  clearModel(): void;
  dispose(): void;
};

export type JsonObject = Record<string, unknown>;
