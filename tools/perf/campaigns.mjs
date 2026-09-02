/**
 * Named, repeatable cross-revision campaigns.
 *
 * Keep revision selection here rather than in a one-off shell command so a
 * long unattended run can be reproduced exactly from a short npm script.
 */

export const FEATURE_BOUNDARY_REVISIONS = Object.freeze([
  '513fe5a',
  '4c1f3d9',
  '795cc69',
  '8418c4d',
  '0f9ae83',
  '8221024',
  '5cb290e',
  'f316e0e',
  '24c3aa8',
  '35d866f',
  '885dd4c',
  'd984eaa',
  '8b65e6e',
  'f5ebace',
  '8395110',
  'def9b52',
  '432f984',
  'e277fb1',
  '3a42934',
  'bfab3f1',
  'e15939d',
  '3096f1d',
  'a6ac1db',
  '0398807',
  '31d2fe9',
  '3350698',
  'ff5d9c8',
  'HEAD',
]);

export const LAST_BENCHMARKED_MASTER = '38440b52d9fc4963d333016c47aeae7f0e7c7f06';

export const CAMPAIGNS = Object.freeze({
  'southern-afternoon-history': Object.freeze({
    description:
      'Southern Ocean rough sea at fixed mid-afternoon and medium camera across feature boundaries',
    suite: 'southern-afternoon',
    revisions: FEATURE_BOUNDARY_REVISIONS,
    rounds: 2,
  }),
  'current-master-history': Object.freeze({
    description:
      'Every first-parent master commit since the last benchmarked master endpoint',
    suite: 'smoke',
    firstParentRanges: Object.freeze([`${LAST_BENCHMARKED_MASTER}..master`]),
    rounds: 2,
  }),
  'current-rebaseline': Object.freeze({
    description:
      'Old cloud-cache baseline, prior master endpoint, and current master across representative scenes',
    suite: 'representative',
    revisions: Object.freeze(['513fe5a', LAST_BENCHMARKED_MASTER, 'master']),
    rounds: 2,
  }),
});
