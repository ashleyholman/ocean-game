export interface InspectionRayHit {
  readonly object: string;
  readonly type: string;
  readonly material: string | null;
  readonly distance: number;
  readonly faceIndex: number | null;
  readonly worldPoint: readonly number[];
  readonly vesselPoint: readonly number[];
  readonly worldNormal: readonly number[] | null;
}

export interface RecordedInspectionRay {
  readonly frame: number;
  readonly client: readonly [number, number];
  readonly canvas: readonly [number, number];
  readonly ndc: readonly [number, number];
  readonly worldOrigin: readonly number[];
  readonly worldDirection: readonly number[];
  readonly vesselOrigin: readonly number[];
  readonly vesselDirection: readonly number[];
  readonly hit: InspectionRayHit | null;
}

/** The small UI-facing surface of the development scene inspection tool. */
export interface InspectionRayRecorder {
  readonly armed: boolean;
  /** Every frozen ray in capture order. Cleared only by an explicit clear. */
  readonly recordedRays: readonly RecordedInspectionRay[];
  /** The newest ray, retained for single-ray diagnostics consumers. */
  readonly recordedRay: RecordedInspectionRay | null;
  arm(): void;
  cancel(): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}
