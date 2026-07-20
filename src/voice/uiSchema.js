// src/voice/uiSchema.js — validated JSON component schema (Zod) for the generated UI.
// Only these 14 approved components render; unknown types are skipped safely.
// URL safety: https-only for any link the UI renders (validated here, not at render).
import { z } from 'zod';

const HttpsUrl = z.string().refine(u => { try { return new URL(u).protocol === 'https:'; } catch { return false; } }, 'https-only');
const Source = z.object({ id: z.string().optional(), source: z.string(), date: z.string().optional(), url: HttpsUrl.optional() }).passthrough();
const Metric = z.object({ label: z.string(), value: z.union([z.string(), z.number()]), trend: z.enum(['up', 'down', 'flat']).optional() });

const P = {
  CountrySummaryCard: z.object({ iso: z.string(), title: z.string(), summary: z.string(), metrics: z.array(Metric).max(6).optional(), sources: z.array(Source).optional() }),
  ComparisonTable: z.object({ title: z.string().optional(), columns: z.array(z.string()).min(2).max(6), rows: z.array(z.array(z.union([z.string(), z.number()]))).max(20), sources: z.array(Source).optional() }),
  MetricCard: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), unit: z.string().optional(), trend: z.enum(['up', 'down', 'flat']).optional(), sources: z.array(Source).optional() }),
  Timeline: z.object({ title: z.string().optional(), events: z.array(z.object({ date: z.string(), label: z.string(), detail: z.string().optional() })).max(30), sources: z.array(Source).optional() }),
  RiskMatrix: z.object({ title: z.string().optional(), risks: z.array(z.object({ label: z.string(), likelihood: z.enum(['low', 'medium', 'high']), impact: z.enum(['low', 'medium', 'high']) })).max(12), sources: z.array(Source).optional() }),
  RouteSummary: z.object({ from: z.string(), to: z.string(), mode: z.enum(['flight', 'shipping', 'trade', 'aid']).optional(), summary: z.string(), sources: z.array(Source).optional() }),
  SourceList: z.object({ title: z.string().optional(), sources: z.array(Source).min(1).max(20) }),
  EvidenceCard: z.object({ id: z.string().optional(), claim: z.string(), source: z.string(), date: z.string().optional(), url: HttpsUrl.optional(), verification: z.enum(['Verified', 'Likely', 'Possible', 'Predicted']).optional() }),
  ScenarioCard: z.object({ title: z.string(), narrative: z.string(), probability: z.number().min(0).max(1).optional(), kind: z.enum(['forecast', 'assessment']).optional(), sources: z.array(Source).optional() }),
  RecommendationCard: z.object({ title: z.string(), recommendation: z.string(), rationale: z.string().optional(), sources: z.array(Source).optional() }),
  SmallChart: z.object({ title: z.string().optional(), kind: z.enum(['bar', 'line']), x: z.array(z.string()).max(24), y: z.array(z.number()).max(24), sources: z.array(Source).optional() }),
  Alert: z.object({ severity: z.enum(['info', 'warning', 'critical']), text: z.string(), sources: z.array(Source).optional() }),
  KeyFinding: z.object({ finding: z.string(), basis: z.enum(['verified', 'evidence', 'assessment', 'uncertain']).optional(), sources: z.array(Source).optional() }),
  ActionList: z.object({ title: z.string().optional(), actions: z.array(z.object({ label: z.string(), detail: z.string().optional() })).min(1).max(10) }),
};

export const APPROVED_COMPONENTS = Object.keys(P);

/** validate one {type:'ui'} block → {ok, component, props, anchor} | {ok:false} (skip) */
export function validateUiBlock(block) {
  if (!block || block.type !== 'ui') return { ok: false, reason: 'not_ui' };
  const schema = P[block.component];
  if (!schema) return { ok: false, reason: 'unknown_component' }; // skip safely
  const res = schema.safeParse(block.props ?? {});
  if (!res.success) return { ok: false, reason: 'props_rejected' };
  return { ok: true, component: block.component, props: res.data, anchor: typeof block.anchor === 'string' ? block.anchor : null };
}
