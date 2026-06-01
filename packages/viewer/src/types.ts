import type * as THREE from 'three';

export type PreviewMode = 'solid' | 'xray' | 'wireframe';
export type ViewKey = 'iso' | 'front' | 'back' | 'side' | 'right' | 'left' | 'top' | 'bottom' | 'custom';

export type Vec3Tuple = [number, number, number];

export type ExplodeState = {
  enabled: boolean;
  factor: number;
  available: boolean;
  targets: number;
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

export type BrepFaceSelection = {
  index: number;
  centroid: Vec3Tuple;
  normal: Vec3Tuple;
  meshName: string | null;
  partId: string | number | null;
  surfaceType: 'planar' | 'cylindrical' | 'other';
  area: number;
  selector: string;
  matchCount: number;
  disambiguation?: string;
  /** Side name (right/left/front/back) for an X/Y extreme face; absent for top/bottom faces
   *  (named by the selector) and for non-extreme or curved faces. */
  directionLabel?: string;
  screenshot?: string;
};

export type PartInfo = {
  faceCount: number;
  bbox: BBoxInfo;
  faces: FaceInfo[];
};

export type LoadModelFormat = 'BREP' | 'STL' | 'MJCF' | 'GLB';

export type ViewerOptions = {
  loaders?: {
    brep?: boolean;
    stl?: boolean;
    glb?: boolean;
    mjcf?: boolean;
  };
  features?: {
    faceSelection?: boolean;
    materials?: boolean;
    explode?: boolean;
    viewCube?: boolean;
  };
};

export type LoadModelOptions = {
  format?: LoadModelFormat | string;
  paramsUrl?: string;
  preserveView?: boolean;
  /** Display scale applied while loading unit-conventional formats such as glTF. */
  unitScale?: number;
  /** Coordinate convention of the loaded asset before viewer display. */
  coordinateSystem?: 'cad-z-up' | 'gltf-y-up' | string;
  /** Logical sub-part id for STL pick/highlight (e.g. parts/<name>/). */
  materialPart?: string;
  /** Compound child labels from models/<model>/metadata.json for BREP assemblies. */
  assemblyPartLabels?: string[];
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
  sourceUrl?: string;
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
  loadGlb(url: string, onLog?: LogHandler, opts?: LoadModelOptions): Promise<PartInfo>;
  loadModel(url: string, onLog?: LogHandler, opts?: LoadModelOptions): Promise<PartInfo>;
  snapshot: SnapshotRenderer;
  setView(viewInput?: ViewSpec | string, opts?: { distance?: number }): ViewKey | string;
  fitView(viewInput?: ViewSpec | string): ViewKey | string;
  cycleView(): ViewKey | string;
  orbit(deltaAzimuth: number, deltaElevation?: number): ViewKey | string;
  setAutoOrbitSpeed(radiansPerSecond: number): void;
  setExplodeEnabled(enabled: boolean): ExplodeState;
  setExplodeFactor(factor: number): ExplodeState;
  getExplodeState(): ExplodeState;
  refreshPreview(): void;
  setMaterialParams(params?: MaterialParams): void;
  setPartMaterial(partKey: string | number, config: MaterialSpec | THREE.ColorRepresentation): boolean;
  setPartMaterialColor(partKey: string | number, color: THREE.ColorRepresentation): boolean;
  setPartMaterialColors(colorsByPart: Record<string, THREE.ColorRepresentation>): void;
  setSelectedPart(partKey: string | number | null): string | number | null;
  setOnSelectedPartChange(handler: ((partKey: string | number | null) => void) | null): void;
  setFaceSelectionEnabled(enabled: boolean): boolean;
  isFaceSelectionEnabled(): boolean;
  canSelectBrepFaces(): boolean;
  setOnSelectedFaceChange(handler: ((selection: BrepFaceSelection | null) => void) | null): void;
  setSelectedFace(faceIndex: number | null): BrepFaceSelection | null;
  getSelectedFace(): BrepFaceSelection | null;
  getMaterialParts(): Array<MaterialPart & { color: string | null }>;
  getSelectedPart(): string | number | null;
  getPartMaterialState(): Record<string, MaterialSpec>;
  getCurrentView(): ViewKey | string;
  hasModel(): boolean;
  clearModel(): void;
  dispose(): void;
};

export type JsonObject = Record<string, unknown>;
