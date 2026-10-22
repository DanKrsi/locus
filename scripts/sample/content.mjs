// Text content for the Aurora-3 sample workspace: code versions, config, CSV.
// The story: a CubeSat avionics bracket goes from kickoff (Jan) to CDR (Apr).

export const legacyUnits = `"""Unit helpers from the heritage project. Superseded by SI inputs (removed in March)."""

KSI_TO_MPA = 6.894757


def ksi_to_mpa(ksi):
    """Convert kilopounds per square inch to megapascals."""
    return ksi * KSI_TO_MPA
`;

export const marginsV1 = `"""Margins of safety for the Aurora-3 avionics bracket."""
from legacy_units import ksi_to_mpa

ULTIMATE_FS = 1.4  # NASA-STD-5001B Table 1, protoflight
YIELD_FS = 1.25


def margin(allowable, limit, factor):
    """MS = allowable / (limit x factor) - 1."""
    return allowable / (limit * factor) - 1


def bracket_margins(limit_stress_mpa):
    ftu = ksi_to_mpa(42.0)  # 6061-T6 ultimate
    fty = ksi_to_mpa(35.0)  # 6061-T6 yield
    return {
        "ultimate": margin(ftu, limit_stress_mpa, ULTIMATE_FS),
        "yield": margin(fty, limit_stress_mpa, YIELD_FS),
    }


def bolt_margins(limit_tension_n, allowable_n):
    return {"ultimate": margin(allowable_n, limit_tension_n, ULTIMATE_FS)}
`;

export const marginsV2 = `"""Margins of safety for the Aurora-3 avionics bracket."""
from dataclasses import dataclass

import yaml


@dataclass(frozen=True)
class Factors:
    ultimate: float
    yield_: float
    fitting: float


def load_factors(path="config/factors.yaml"):
    """Design factors live in one reviewed file instead of in the code."""
    with open(path) as f:
        raw = yaml.safe_load(f)
    return Factors(raw["ultimate"], raw["yield"], raw["fitting"])


def margin(allowable, limit, factor):
    """MS = allowable / (limit x factor) - 1."""
    return allowable / (limit * factor) - 1


def bracket_margins(limit_stress_mpa, f, ftu=290.0, fty=241.0):
    return {
        "ultimate": margin(ftu, limit_stress_mpa, f.ultimate),
        "yield": margin(fty, limit_stress_mpa, f.yield_),
    }


def bolt_margins(limit_tension_n, allowable_n, f):
    # NASA-STD-5020B 4.2.2: the fitting factor multiplies the factor of safety.
    return {"ultimate": margin(allowable_n, limit_tension_n, f.ultimate * f.fitting)}
`;

export const marginsV3 =
  marginsV2.replace('    fitting: float\n', '    fitting: float\n    separation: float\n').replace(
    'return Factors(raw["ultimate"], raw["yield"], raw["fitting"])',
    'return Factors(raw["ultimate"], raw["yield"], raw["fitting"], raw["separation"])',
  ) +
  `

def separation_margin(preload_min_n, limit_tension_n, f):
    """Positive while the joint stays clamped (NASA-STD-5020B 4.2.3)."""
    return preload_min_n / (limit_tension_n * f.separation * f.fitting) - 1
`;

// Edited after the review notes were written, so live links to it have to follow moved lines.
export const marginsV4 = marginsV3.replace(
  '"""Margins of safety for the Aurora-3 avionics bracket."""\n',
  `"""Margins of safety for the Aurora-3 avionics bracket.

Inputs are limit loads (no factors applied). Factors come from config/factors.yaml,
which is reviewed against NASA-STD-5001B and NASA-STD-5020B.
"""
`,
);

export const loadsPy = `"""Load estimates for the avionics bracket."""
from math import pi, sqrt

G = 9.80665


def limit_force_n(mass_kg, load_factor_g):
    """Quasi-static limit force for a load factor in g."""
    return mass_kg * G * load_factor_g


def miles_grms(fn_hz, q, asd_g2_per_hz):
    """Miles' equation: RMS response of a single-degree-of-freedom system."""
    return sqrt(pi / 2 * fn_hz * q * asd_g2_per_hz)


def three_sigma_g(fn_hz, q, asd_g2_per_hz):
    return 3 * miles_grms(fn_hz, q, asd_g2_per_hz)
`;

export const factorsV1 = `# Design and test factors for the Aurora-3 bracket (protoflight approach).
# Sources: NASA-STD-5001B Table 1 (metallic structures), NASA-STD-5020B 4.2.2 (fitting factor).
ultimate: 1.4
yield: 1.25
fitting: 1.15
`;

export const factorsV2 = factorsV1 + `# NASA-STD-5020B 4.2.3, Figure 1: separation-critical joint (connector side).
separation: 1.2
`;

export const testMargins = `from margins import Factors, bolt_margins, bracket_margins, margin, separation_margin

F = Factors(ultimate=1.4, yield_=1.25, fitting=1.15, separation=1.2)


def test_margin_definition():
    assert abs(margin(140.0, 100.0, 1.4) - 0.0) < 1e-9


def test_bracket_positive_after_pdr():
    m = bracket_margins(limit_stress_mpa=120.0, f=F)
    assert m["ultimate"] > 0 and m["yield"] > 0


def test_fitting_factor_reduces_bolt_margin():
    with_ff = bolt_margins(2000.0, 5600.0, F)["ultimate"]
    without = margin(5600.0, 2000.0, F.ultimate)
    assert with_ff < without


def test_joint_stays_clamped():
    assert separation_margin(preload_min_n=3500.0, limit_tension_n=1800.0, f=F) > 0
`;

export const testLog = `run,date,axis,level,input_grms,first_mode_hz,peak_response_g,result
1,2026-03-24,X,low-level sine,0.25,318,4.1,pass
2,2026-03-24,X,protoflight random,10.0,316,38.2,pass
3,2026-03-25,Y,low-level sine,0.25,341,3.8,pass
4,2026-03-25,Y,protoflight random,10.0,339,35.6,pass
5,2026-03-26,Z,low-level sine,0.25,312,4.4,pass
6,2026-03-26,Z,protoflight random,10.0,312,41.7,pass
7,2026-03-26,Z,post-test sine,0.25,311,4.3,pass (shift < 5%)
`;

export const readme = `# Aurora-3 avionics bracket (Locus sample)

A small, made-up CubeSat project used to show what Locus can do. Open the notes in \`notes/\`,
starting with **00 Start here**.

The standards in \`docs/standards/\` are real NASA technical standards, approved for public
release (distribution unlimited), from https://standards.nasa.gov.
`;

/** Spoken summary of the April 16 review, one sentence per segment (Windows text-to-speech). */
export const meetingSegments = [
  'Aurora 3 avionics bracket, design review, April sixteenth.',
  'Since P D R we thickened the mounting flange from two to three millimetres.',
  'Bolt margins now include the fitting factor of one point one five from NASA standard fifty twenty.',
  'The protoflight vibration test passed. The first mode is at three hundred and twelve hertz.',
  'Action: confirm the separation factor for the connector side joint before C D R closes.',
];
