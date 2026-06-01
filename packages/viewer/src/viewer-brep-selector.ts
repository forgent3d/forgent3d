import * as THREE from 'three';

export type BrepFaceRange = {
  faceIndex: number;
  triStart: number;
  triCount: number;
  centroid: THREE.Vector3;
  normal: THREE.Vector3;
  surfaceType: 'planar' | 'cylindrical' | 'other';
  area: number;
  radius?: number;
  axis?: THREE.Vector3;
  boundsMin?: THREE.Vector3;
  boundsMax?: THREE.Vector3;
};

export type BrepFaceReference = {
  mesh: THREE.Mesh;
  range: BrepFaceRange;
};

type PrincipalAxis = 'X' | 'Y' | 'Z';

export type SelectorSynthesis = {
  selector: string;
  matchCount: number;
  disambiguation?: string;
  /** Human-facing side name (right/left/front/back) for an X/Y extreme face. Omitted for
   *  top/bottom (the selector already names them) and for non-extreme or curved faces. */
  directionLabel?: string;
};

const AXIS_ALIGNMENT_DOT = Math.cos(THREE.MathUtils.degToRad(10));
const FACE_FACING_DOT = 0.99;

// Signed-axis → direction name, matching the viewcube convention in
// viewer-navigation.ts (+X right / -X left, +Y back / -Y front, +Z top / -Z bottom).
const DIRECTION_NAMES: Record<PrincipalAxis, { positive: string; negative: string }> = {
  X: { positive: 'right', negative: 'left' },
  Y: { positive: 'back', negative: 'front' },
  Z: { positive: 'top', negative: 'bottom' }
};

export function synthesizeSelector(face: BrepFaceReference, allFaces: BrepFaceReference[]): SelectorSynthesis {
  const refs = allFaces.length ? allFaces : [face];
  const tol = selectorTolerance(refs);
  const range = face.range;
  const centroid = range.centroid;
  const normalAxis = principalAxisForVector(range.normal, AXIS_ALIGNMENT_DOT);

  if (range.surfaceType === 'planar' && normalAxis) {
    const maxExtremeMatches = refs.filter((candidate) => isPlanarAxisExtreme(candidate.range, refs, normalAxis, 'max', tol));
    const minExtremeMatches = refs.filter((candidate) => isPlanarAxisExtreme(candidate.range, refs, normalAxis, 'min', tol));
    const direction = maxExtremeMatches.some((candidate) => candidate.range === range)
      ? 'max'
      : minExtremeMatches.some((candidate) => candidate.range === range)
        ? 'min'
        : null;
    if (direction) {
      const extremeMatches = direction === 'max' ? maxExtremeMatches : minExtremeMatches;
      const selector =
        normalAxis === 'Z' && direction === 'max'
          ? 'top_face'
          : normalAxis === 'Z' && direction === 'min'
            ? 'bottom_face'
            : `extreme_face(Axis.${normalAxis}, '${direction}')`;
      // Humanize only the X/Y extremes (right/left/front/back) — the one case the
      // selector text does not already convey. top_face/bottom_face name themselves
      // (label would be redundant); derive from `direction` so it always agrees with
      // the selector, never from the raw normal.
      const sideLabel =
        normalAxis === 'Z'
          ? undefined
          : direction === 'max'
            ? DIRECTION_NAMES[normalAxis].positive
            : DIRECTION_NAMES[normalAxis].negative;
      return withDisambiguation(selector, extremeMatches.length, centroid, sideLabel);
    }

    // Non-extreme planar face: it is not a "side" of the part, so no direction label
    // (the selector already pins axis + position exactly).
    const value = axisValue(centroid, normalAxis);
    const matches = refs.filter((candidate) => isPlanarAxisFaceAt(candidate.range, normalAxis, value, tol));
    return withDisambiguation(`face_at(Axis.${normalAxis}, ${formatNumber(value)})`, matches.length, centroid);
  }

  if (range.surfaceType === 'cylindrical' && range.axis && Number.isFinite(range.radius)) {
    const cylinderAxis = principalAxisForVector(range.axis, AXIS_ALIGNMENT_DOT);
    if (cylinderAxis && range.radius != null) {
      const matches = refs.filter((candidate) => isCylindricalHoleMatch(candidate.range, cylinderAxis, range.radius!, tol));
      return withDisambiguation(
        `holes(radius=${formatNumber(range.radius)}, axis=Axis.${cylinderAxis})`,
        matches.length,
        centroid
      );
    }
  }

  const nx = formatNumber(range.normal.x);
  const ny = formatNumber(range.normal.y);
  const nz = formatNumber(range.normal.z);
  const matches = refs.filter((candidate) => candidate.range.normal.dot(range.normal) > FACE_FACING_DOT);
  return withDisambiguation(`face_facing([${nx}, ${ny}, ${nz}])`, Math.max(1, matches.length), centroid);
}

function withDisambiguation(
  selector: string,
  matchCount: number,
  centroid: THREE.Vector3,
  directionLabel?: string
): SelectorSynthesis {
  const normalizedCount = Math.max(1, matchCount);
  return {
    selector,
    matchCount: normalizedCount,
    disambiguation: normalizedCount > 1 ? `near (${formatVec3(centroid)})` : undefined,
    directionLabel
  };
}

function selectorTolerance(refs: BrepFaceReference[]): number {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const ref of refs) {
    min.min(ref.range.centroid);
    max.max(ref.range.centroid);
    if (ref.range.boundsMin) min.min(ref.range.boundsMin);
    if (ref.range.boundsMax) max.max(ref.range.boundsMax);
  }
  if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) return 1e-3;
  const diag = min.distanceTo(max);
  return Math.max(1e-3, diag * 1e-5);
}

function principalAxisForVector(vector: THREE.Vector3, minDot: number): PrincipalAxis | null {
  const len = vector.length();
  if (!Number.isFinite(len) || len <= 1e-8) return null;
  const ax = Math.abs(vector.x) / len;
  const ay = Math.abs(vector.y) / len;
  const az = Math.abs(vector.z) / len;
  if (ax >= ay && ax >= az && ax >= minDot) return 'X';
  if (ay >= ax && ay >= az && ay >= minDot) return 'Y';
  if (az >= ax && az >= ay && az >= minDot) return 'Z';
  return null;
}

function axisValue(vector: THREE.Vector3, axis: PrincipalAxis): number {
  if (axis === 'X') return vector.x;
  if (axis === 'Y') return vector.y;
  return vector.z;
}

function isNearly(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function isPlanarAxisAligned(range: BrepFaceRange, axis: PrincipalAxis): boolean {
  if (range.surfaceType !== 'planar') return false;
  const axisComponent = Math.abs(axisValue(range.normal, axis));
  const length = range.normal.length() || 1;
  return axisComponent / length >= AXIS_ALIGNMENT_DOT;
}

function isPlanarAxisExtreme(
  range: BrepFaceRange,
  refs: BrepFaceReference[],
  axis: PrincipalAxis,
  direction: 'max' | 'min',
  tol: number
): boolean {
  if (!isPlanarAxisAligned(range, axis)) return false;
  const planarAxisFaces = refs.map((ref) => ref.range).filter((candidate) => isPlanarAxisAligned(candidate, axis));
  if (!planarAxisFaces.length) return false;
  const selectedValue = axisValue(range.centroid, axis);
  const extremeValue =
    direction === 'max'
      ? Math.max(...planarAxisFaces.map((candidate) => axisValue(candidate.centroid, axis)))
      : Math.min(...planarAxisFaces.map((candidate) => axisValue(candidate.centroid, axis)));
  return isNearly(selectedValue, extremeValue, tol);
}

function isPlanarAxisFaceAt(range: BrepFaceRange, axis: PrincipalAxis, value: number, tol: number): boolean {
  return isPlanarAxisAligned(range, axis) && isNearly(axisValue(range.centroid, axis), value, tol);
}

function isCylindricalHoleMatch(range: BrepFaceRange, axis: PrincipalAxis, radius: number, tol: number): boolean {
  if (range.surfaceType !== 'cylindrical' || !range.axis || !Number.isFinite(range.radius)) return false;
  const candidateAxis = principalAxisForVector(range.axis, AXIS_ALIGNMENT_DOT);
  return candidateAxis === axis && isNearly(range.radius!, radius, Math.max(tol, radius * 1e-3));
}

function formatVec3(vector: THREE.Vector3): string {
  return `${formatNumber(vector.x)}, ${formatNumber(vector.y)}, ${formatNumber(vector.z)}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.abs(value) < 1e-9 ? 0 : value;
  return rounded.toFixed(3).replace(/\.?0+$/, '');
}
