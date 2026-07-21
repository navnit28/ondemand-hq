# CE Monochrome Type System (ODA black-and-white) — 2026-07-21

Inter (self-hosted, since 293981b). NO color-based differentiation — hierarchy is carried by
LUMINANCE (3 inks), WEIGHT (4 tiers), CASE and LETTER-SPACING only. Rules follow Palantir
Blueprint / IBM Carbon dark-dashboard practice: no thin weights on near-black surfaces
(halation), uppercase + widened tracking reserved for small metadata/status tiers, chart
titles pinned with explicit grid padding.

## Inks (luminance hierarchy — the only "palette")
| Token | Value | Use |
|---|---|---|
| `--pl-ink` | `#ffffff` | Primary: view titles, country names, key values |
| `--pl-ink-dim` | `#e5e7eb` | Secondary: entity/company labels, body, control labels, chip text |
| `--pl-ink-faint` | `#9ca3af` | Muted/tertiary: metadata, timestamps, axis labels, placeholders |

## Type scale (size / weight / case / tracking)
| Tier token | Spec | Assigned to |
|---|---|---|
| `--ce-t-display` | 17px · 700 · sentence · -0.01em | CE view title (ODA Intelligence — Correlation Engine) |
| `--ce-t-title` | 12px · 600 · UPPERCASE · +0.08em | Panel/card titles (Connected Dots, chart titles) |
| `--ce-t-body` | 12.5px · 400 · sentence · 0 | Narrative/body text, evidence snippets |
| `--ce-t-label` | 11px · 500 · sentence · +0.01em | Control labels (max age, min weight, labels, physics), chips |
| `--ce-t-meta` | 10px · 600 · UPPERCASE · +0.08em | Status/run-strip tags, timestamps, legend keys |
| `--ce-t-badge` | 9px · 700 · UPPERCASE · +0.06em | Evidence-count badges, tier chips |

## Entity differentiation WITHOUT color (graph canvas + lists)
| Entity class | Treatment |
|---|---|
| Countries (Kenya, UAE, Palestine) | PRIMARY: `#ffffff`, weight 600, largest label size |
| Companies/entities (Kengen, Masdar) | SECONDARY: `#e5e7eb`, weight 500, smaller |
| Evidence-count badges | METADATA: 700, tiny, white numeral on `#1f1f1f` pill |
| Links | `#e5e7eb`, weight 500, underline on rest (affordance = underline, not hue) |
| Statuses (PASS/SHORT/SKIP) | `--ce-t-meta` uppercase; verdict via weight (700) not hue |

Weights allowed: 400 / 500 / 600 / 700 only. 300-or-thinner is FORBIDDEN on `--pl-bg`
surfaces (halation). Gray tints `#d0d0d0/#a0a0a0/#707070` remain for chart SERIES
(data encoding), never for text ink.
