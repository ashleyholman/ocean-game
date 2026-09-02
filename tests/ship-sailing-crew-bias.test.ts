import { describe, expect, it } from 'vitest';
import {
  buildHeadingHoldBiasEvidence,
  type HeadingHoldBiasRunSummary,
} from '../src/vessel/schooner/SailingCrewEvidence';

/**
 * S5 heading-hold centring.
 *
 * The August 2026 investigation (docs/sailing/DEFAULT_HEADING_HOLD_BIAS_REPORT.md)
 * found the settled default hold parked ~1.4° starboard of the ordered course
 * in every independent rollout: the sail plan's steady weather helm plus a
 * helmsman who eased corrective rudder to exactly zero before the perceived
 * crossing formed a one-sided limit cycle. Unsigned RMS gates cannot see that
 * failure — every biased run passed them — so these gates are signed.
 *
 * The properties, not the texture: individual runs may wander and overshoot
 * like a human, but independent settled rollouts must average onto the order,
 * the mirrored tack must not share a fixed compass side with the default
 * tack, and eases must not all leave the bow on the weather-drift side.
 */
describe('S5 heading-hold centring — the settled hold carries no standing bias', () => {
  it(
    'centres independent settled rollouts on the ordered course, on both tacks',
    { tags: ['slow', 'sailing'], timeout: 600_000 },
    () => {
      const evidence = buildHeadingHoldBiasEvidence();
      const { ensemble } = evidence;

      // The ensemble mean is the finding's own statistic: +1.35° before the
      // holding-helm fix, with every seed on the same side.
      expect(Math.abs(ensemble.meanSignedErrorDeg)).toBeLessThanOrEqual(0.35);
      expect(Math.abs(ensemble.mirroredMeanSignedErrorDeg)).toBeLessThanOrEqual(
        0.35,
      );
      // Tack symmetry: a fixed compass-handedness bias would move the pair
      // midpoints away from zero even if each tack looked plausible alone.
      expect(Math.abs(ensemble.meanPairMidpointDeg)).toBeLessThanOrEqual(0.3);
      // No individual seed may hide a hard one-sided park inside a soft mean.
      expect(ensemble.maxAbsRunMeanDeg).toBeLessThanOrEqual(1.0);

      // The competent-human texture is preserved, not replaced by a servo:
      // flat-water RMS stays in the existing calm band and the intervention
      // cadence stays event-like.
      for (const run of [...evidence.runs, ...evidence.mirroredRuns]) {
        expect(run.settledRmsErrorDeg).toBeLessThanOrEqual(2);
        expect(run.interventionsPerMinute).toBeGreaterThanOrEqual(1);
        expect(run.interventionsPerMinute).toBeLessThanOrEqual(20);
      }

      // Release quality. Weather helm drifts the default tack to starboard
      // and the mirrored tack to port; before the fix, every settled ease
      // happened with the bow still perceived on that drift side (21 of 21 in
      // the report's audit). A centred controller eases around the crossing,
      // so a meaningful share of eases must land off the drift side.
      const offDriftShare = (
        runs: HeadingHoldBiasRunSummary[],
        driftSide: 'starboard' | 'port',
      ) => {
        const eases = runs.reduce((sum, run) => sum + run.easeCount, 0);
        const onDrift = runs.reduce(
          (sum, run) =>
            sum +
            (driftSide === 'starboard'
              ? run.easesWhileStarboardOfOrder
              : run.easesWhilePortOfOrder),
          0,
        );
        expect(eases).toBeGreaterThanOrEqual(10);
        return (eases - onDrift) / eases;
      };
      expect(offDriftShare(evidence.runs, 'starboard')).toBeGreaterThanOrEqual(
        0.15,
      );
      expect(
        offDriftShare(evidence.mirroredRuns, 'port'),
      ).toBeGreaterThanOrEqual(0.15);
    },
  );
});
