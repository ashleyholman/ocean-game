/**
 * Explicit operations in the presented-frame render transaction.
 *
 * The callbacks keep Three.js and project-specific render resources out of the
 * scheduler while making pass order, temporal selection, and state restoration
 * independently verifiable.
 */
export interface RenderPipelineOperations {
  beginSubmission(): void;
  prepareFrame(): void;
  shouldUseTemporalResolve(): boolean;
  renderTemporal(): void;
  prepareDirectRender(): void;
  renderDirect(): void;
  endSubmission(): void;
}

export class RenderPipeline {
  constructor(private readonly operations: RenderPipelineOperations) {}

  render(): void {
    this.operations.beginSubmission();
    // Preserve the existing terrain-hook failure semantics: preparation ran
    // before the render try/finally and therefore owns its own error handling.
    this.operations.prepareFrame();
    try {
      if (this.operations.shouldUseTemporalResolve()) {
        this.operations.renderTemporal();
      } else {
        this.operations.prepareDirectRender();
        this.operations.renderDirect();
      }
    } finally {
      this.operations.endSubmission();
    }
  }
}
