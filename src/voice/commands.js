// src/voice/commands.js — strict Zod-validated ALLOWLIST for voice world-commands.
// Commands arrive ONLY as structured {type:'command'} blocks from the stream parser;
// they are validated here before execution — malformed/unsupported commands are
// rejected safely (returned as {ok:false}); arbitrary model text can never act.
import { z } from 'zod';

const Iso = z.string().regex(/^[A-Za-z]{2}$/).transform(s => s.toUpperCase());
const Lat = z.number().min(-90).max(90);
const Lng = z.number().min(-180).max(180);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rotateTo'), args: z.object({ lat: Lat, lng: Lng }) }),
  z.object({ action: z.literal('zoom'), args: z.object({ level: z.number().min(0.6).max(3.5) }) }),
  z.object({ action: z.literal('showCountry'), args: z.object({ iso: Iso }) }),
  z.object({ action: z.literal('openLayer'), args: z.object({ layer: z.enum(['intel', 'correlations', 'x', 'opps', 'risks', 'agreements', 'timeline']) }) }),
  z.object({ action: z.literal('compare'), args: z.object({ isoA: Iso, isoB: Iso }) }),
  z.object({ action: z.literal('resetView'), args: z.object({}).optional() }),
  z.object({ action: z.literal('setTimeline'), args: z.object({ from: IsoDate.optional(), to: IsoDate.optional() }).refine(a => a.from || a.to, 'from or to required') }),
  z.object({ action: z.literal('openPanel'), args: z.object({ panel: z.enum(['intelligence', 'tray', 'captions']) }) }),
  z.object({ action: z.literal('closePanel'), args: z.object({ panel: z.enum(['intelligence', 'tray', 'captions']) }) }),
]);

/** validate one raw block ({type:'command',action,args}) → {ok, command|reason} */
export function validateCommand(block) {
  if (!block || block.type !== 'command') return { ok: false, reason: 'not_a_command' };
  const res = CommandSchema.safeParse({ action: block.action, args: block.args ?? {} });
  if (!res.success) return { ok: false, reason: 'schema_rejected' };
  return { ok: true, command: res.data };
}

// typed minimal conversation context — the ONLY state shape sent with each turn
export const ContextSchema = z.object({
  selectedCountry: z.string().nullable(),
  selectedRegion: z.string().nullable(),
  activeLayer: z.string().nullable(),
  timelineRange: z.object({ from: z.string().optional(), to: z.string().optional() }).nullable(),
  selectedMarker: z.string().nullable(),
  activeFilters: z.record(z.string(), z.unknown()).nullable(),
  cameraFocus: z.object({ lat: Lat, lng: Lng }).nullable(),
});
export function buildContext(partial = {}) {
  return ContextSchema.parse({
    selectedCountry: partial.selectedCountry ?? null,
    selectedRegion: partial.selectedRegion ?? null,
    activeLayer: partial.activeLayer ?? null,
    timelineRange: partial.timelineRange ?? null,
    selectedMarker: partial.selectedMarker ?? null,
    activeFilters: partial.activeFilters ?? null,
    cameraFocus: partial.cameraFocus ?? null,
  });
}
