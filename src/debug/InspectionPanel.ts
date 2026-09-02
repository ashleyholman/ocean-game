import type {
  InspectionRayRecorder,
  RecordedInspectionRay,
} from '../runtime/diagnostics/InspectionRayRecorder';
import { ControlGroup, ensurePanelStyle } from '../ui/controls';

export interface InspectionPanelHandle {
  readonly element: HTMLElement;
  update(): void;
  dispose(): void;
}

/** Developer UI for freezing exact screen rays before the vessel moves on. */
export function createInspectionPanel(
  recorder: InspectionRayRecorder,
): InspectionPanelHandle {
  ensurePanelStyle();

  const root = document.createElement('aside');
  root.className = 'devpanel';

  const title = document.createElement('h2');
  title.textContent = 'Drift · scene inspection';
  root.appendChild(title);

  const controls = new ControlGroup(root);
  controls.section('Ray capture');
  controls.buttons([
    {
      label: 'Add ray',
      title: 'Hide the debug window and append the next scene click',
      onClick: () => recorder.arm(),
    },
    { label: 'Cancel', onClick: () => recorder.cancel() },
    {
      label: 'Clear all',
      title: 'Remove every recorded ray and marker',
      onClick: () => recorder.clear(),
    },
    {
      label: 'Copy ray set',
      title: 'Copy every recorded ray as pasteable JSON',
      onClick: () => {
        void navigator.clipboard?.writeText(
          serializeInspectionRaySet(recorder.recordedRays),
        );
      },
    },
  ]);
  const readout = controls.readout();

  const refresh = (): void => {
    const count = recorder.recordedRays.length;
    readout.textContent = recorder.armed
      ? [
        'ARMED',
        'Click the scene to append a ray.',
        `Esc cancels · ${count} previous ${count === 1 ? 'ray' : 'rays'} retained.`,
      ].join('\n')
      : formatRays(recorder.recordedRays);
  };
  const unsubscribe = recorder.subscribe(refresh);
  refresh();

  return {
    element: root,
    update: refresh,
    dispose: () => {
      unsubscribe();
      recorder.cancel();
      root.remove();
    },
  };
}

/** A self-identifying, lossless record that can be pasted into a bug report. */
export function serializeInspectionRaySet(
  rays: readonly RecordedInspectionRay[],
): string {
  return JSON.stringify(
    {
      kind: 'drift-inspection-ray-set',
      version: 1,
      rays,
    },
    null,
    2,
  );
}

function formatRays(rays: readonly RecordedInspectionRay[]): string {
  if (rays.length === 0) {
    return [
      'No rays recorded.',
      '',
      'Frozen records are also published at',
      '#drift-browser-diagnostics',
    ].join('\n');
  }

  return [
    rays.map((ray, index) => formatRay(ray, index + 1)).join('\n\n'),
    '',
    `${rays.length} ${rays.length === 1 ? 'ray' : 'rays'} · DOM record:`,
    '#drift-browser-diagnostics',
  ].join('\n');
}

function formatRay(ray: RecordedInspectionRay, number: number): string {
  const hit = ray.hit;
  return [
    `RAY ${number} · frame ${ray.frame}`,
    `canvas      ${formatPair(ray.canvas)} px`,
    `origin ship ${formatVector(ray.vesselOrigin)}`,
    `direction   ${formatVector(ray.vesselDirection)}`,
    hit ? `hit          ${hit.object}` : 'hit          none',
    hit ? `material     ${hit.material ?? '—'}` : '',
    hit ? `face         ${hit.faceIndex ?? '—'}` : '',
    hit ? `point ship   ${formatVector(hit.vesselPoint)}` : '',
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n');
}

function formatPair(values: readonly number[]): string {
  return values.map((value) => value.toFixed(1)).join(', ');
}

function formatVector(values: readonly number[]): string {
  return values.map((value) => value.toFixed(4)).join(', ');
}
