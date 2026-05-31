declare module 'occt-import-js' {
  type OcctOptions = {
    locateFile?: (file: string) => string;
  };

  type OcctModule = {
    ReadBrepFile(
      data: Uint8Array,
      options?: Record<string, unknown>
    ): {
      success: boolean;
      meshes: Array<{
        name?: string;
        color?: [number, number, number] | null;
        attributes: {
          position: { array: ArrayLike<number> };
          normal?: { array: ArrayLike<number> };
        };
        index: { array: ArrayLike<number> };
        brep_faces: Array<{ first: number; last: number }>;
      }>;
    };
  };

  export default function occtImportJs(options?: OcctOptions): Promise<OcctModule>;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}
