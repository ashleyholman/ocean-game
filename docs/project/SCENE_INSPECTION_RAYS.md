# Scene inspection rays

The development build can freeze one exact screen ray and publish it as inert
DOM JSON. This is the preferred way to report a small visual geometry fault:
the investigator receives the camera origin, direction, first visible hit and
vessel-local coordinates without trying to reproduce a moving view with a
second cursor.

The bridge is development-only. It is created behind `import.meta.env.DEV` and
does not exist in a production bundle.

## Capture a ray

1. Open the game with `?debug=inspect` (or open **Debug → Inspect** from any
   `?debug` page).
2. Position the embodied or cinematic camera at the fault.
3. Select **Record next click**.
4. Click the faulty point in the scene.

While armed, the debug UI hides, the canvas cursor becomes a crosshair and a
banner confirms that the next click will be captured. The bridge consumes that
single pointer event in the capture phase, so the game cannot also interpret it
as a look, walk or interaction command. `Esc` or **Cancel** leaves the previous
record untouched. **Clear** removes the record and its marker.

The first rendered intersection receives a yellow three-axis cross. A marker on
ship geometry is parented to the vessel and therefore continues to follow its
motion; a world hit remains in world space. The marker is itself excluded from
later inspection raycasts.

## Read the record programmatically

The complete live diagnostic state is the text of:

```html
<script id="drift-browser-diagnostics" type="application/json">
```

Read it with ordinary DOM access:

```js
const diagnostics = JSON.parse(
  document.querySelector('#drift-browser-diagnostics').textContent,
);
const ray = diagnostics.inspectionRay.recorded;
```

Do not rely on a `window` expando for this data. Browser automation can execute
in an isolated JavaScript world whose `window` is not the page's `window`, while
the DOM remains shared. Publishing inert JSON in the document is what makes the
record consistently retrievable by a later session.

The element is rewritten after every presented frame. Its top-level fields are:

- `version`: schema version; currently `2`;
- `frame`: the latest presented diagnostic frame;
- `viewport`: canvas CSS bounds used for screen-to-NDC conversion;
- `camera`: current world and vessel-local camera transforms plus projection
  matrices;
- `vesselWorldMatrix`: the active vessel transform;
- `walker`: embodied player position and eye height, when present;
- `inspectionRay.armed`: whether the next primary click will be captured;
- `inspectionRay.recorded`: the immutable record, or `null`.

The recorded ray contains:

| Field | Meaning |
| --- | --- |
| `frame` | Presented frame at which capture began |
| `client`, `canvas`, `ndc` | Click in page, canvas and normalised-device coordinates |
| `worldOrigin`, `worldDirection` | Frozen world-space ray |
| `vesselOrigin`, `vesselDirection` | The same ray transformed by the vessel inverse at capture time |
| `hit` | First visible scene intersection, or `null` |

When present, `hit` contains the nearest object's inherited name, Three.js
object type, material name/type, distance, face index, world and vessel-local
points, and world-space face normal.

## Why both coordinate spaces matter

The world values describe exactly what the renderer saw. The vessel-local
values are normally the useful evidence for hull, deck and interior faults.
They are computed at the click and never recomputed, so roll, pitch, heave,
translation and later camera movement cannot move the evidence beneath the
investigator. A ray that hit the moving ocean can still be replayed against
static ship-region geometry using `vesselOrigin` and `vesselDirection`.

The first live hit may legitimately be the ocean, sky-adjacent scenery or an
external fitting when a hull surface is missing. That is evidence of the hole,
not a reason to discard the ray. Replay the frozen vessel-local ray against the
candidate ship region meshes, using a front-sided material first; a two-sided
replay is useful for finding the back of an exterior face that the renderer
correctly ignored.

For a regression test, retain the reported precision and cast against the
actual generated region mesh:

```ts
const origin = new THREE.Vector3(...recorded.vesselOrigin);
const direction = new THREE.Vector3(...recorded.vesselDirection);
const mesh = new THREE.Mesh(
  geometry,
  new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
);
const hit = new THREE.Raycaster(origin, direction.normalize(), 0, 10)
  .intersectObject(mesh, false)[0];
```

Assert the intended region, a distance before the erroneous background hit,
and the expected join station or coordinate. Front-sided replay is important:
a face with the wrong winding exists mathematically but is still a hole in the
rendered ship.

## Ownership

| File | Responsibility |
| --- | --- |
| `src/runtime/diagnostics/BrowserDiagnosticsBridge.ts` | DOM publication, click interception, raycast, coordinate transforms and marker lifecycle |
| `src/runtime/diagnostics/InspectionRayRecorder.ts` | UI-facing recorder and record types |
| `src/debug/InspectionPanel.ts` | Debug controls and compact human readout |
| `src/runtime/RuntimeUi.ts` | Lazy panel registration and `?debug=inspect` deep link |
| `src/main.ts` | Development-only bridge assembly and post-frame publication |
| `tests/browser-diagnostics-bridge.test.ts` | Capture, event interception, DOM schema and motion immutability contract |

## Current limitation and extension point

Schema version 2 stores one immutable record. A new captured click replaces the
previous one, and **Clear** removes it. To support a flagged set, change the
recorder contract to an ordered record collection, retain one marker per entry,
add per-entry removal in the panel, publish the array in the DOM, and bump the
schema version. Keep each record immutable and vessel-local; do not turn the
collection into a list of live points that drift when the ship moves.
