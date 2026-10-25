// Code for the Locus demo workspace: one small file in three versions, so the demo shows live
// links that follow moved lines, a link whose lines were edited, pinned links and a code diff.

// First draft: one hard-coded factor.
export const codeV1 = `"""Margin check for the demo bracket."""

FACTOR = 1.4  # ultimate design factor, NASA-STD-5001B Table 1


def margin(allowable, load, factor=FACTOR):
    """Margin of safety: allowable / (load x factor) - 1."""
    return allowable / (load * factor) - 1


def check(cases, parts):
    """Every part under every load case; returns what needs a redesign."""
    failed = []
    for case in cases:
        for part in parts:
            ms = margin(part.allowable, case.load * part.share)
            if ms < 0:
                failed.append((case.name, part.name, ms))
    return failed
`;

// Revision: factors in one place, and bolts take a fitting factor.
export const codeV2 = `"""Margin check for the demo bracket."""

FACTORS = {"ultimate": 1.4, "yield": 1.25}  # NASA-STD-5001B Table 1
FITTING = 1.15  # bolts only, NASA-STD-5020B


def margin(allowable, load, factor=FACTORS["ultimate"]):
    """Margin of safety: allowable / (load x factor) - 1."""
    return allowable / (load * factor) - 1


def check(cases, parts):
    """Every part under every load case; returns what needs a redesign."""
    failed = []
    for case in cases:
        for part in parts:
            factor = FACTORS["ultimate"] * (FITTING if part.is_bolt else 1)
            ms = margin(part.allowable, case.load * part.share, factor)
            if ms < 0:
                failed.append((case.name, part.name, ms))
    return failed
`;

// Edited after the notes were written: lines move (live links follow them) and margin() changes
// (its live link shows "changed").
export const codeV3 = codeV2
  .replace(
    '"""Margin check for the demo bracket."""\n',
    '"""Margin check for the demo bracket.\n\nLoads are limit loads; factors are applied here.\n"""\n',
  )
  .replace('    return allowable / (load * factor) - 1\n', '    if load <= 0:\n        return float("inf")\n    return allowable / (load * factor) - 1\n');

// Spoken lines for the short recording (timestamp links point at each one).
export const audioLines = [
  'Welcome to the Locus demo. This is a short recording you can cite by time.',
  'Decision: we move to the twenty twenty-two edition of the standard.',
  'Action: bolts now include the fitting factor of one point one five.',
];
