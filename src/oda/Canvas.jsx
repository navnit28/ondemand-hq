// Canvas.jsx — the adaptive live canvas (Phase 3 §1, centre area).
// Renders ONLY the renderer for the ACTIVE stage — never all at once. The
// active stage is a pure function of real run state (stageMap.activeStage);
// no timers, no simulated transitions.
import React, { useEffect, useState } from 'react';
import { activeStage, STAGE_LABELS, stageArtifact } from './stageMap.js';

import StageUnderstanding from './stages/StageUnderstanding.jsx';
import StageRouting from './stages/StageRouting.jsx';
import StageIssueTree from './stages/StageIssueTree.jsx';
import StageAssumptions from './stages/StageAssumptions.jsx';
import StageEvidence from './stages/StageEvidence.jsx';
import StageBenchmark from './stages/StageBenchmark.jsx';
import StageCountry from './stages/StageCountry.jsx';
import StageModel from './stages/StageModel.jsx';
import StageStoryline from './stages/StageStoryline.jsx';
import StageDocument from './stages/StageDocument.jsx';
import StageArabic from './stages/StageArabic.jsx';
import StageGallery from './stages/StageGallery.jsx';
import StageFailed from './stages/StageFailed.jsx';
import StageLiveDeck from './stages/StageLiveDeck.jsx';

const RENDERERS = {
  'live-deck': StageLiveDeck,
  understanding: StageUnderstanding,
  routing: StageRouting,
  'issue-tree': StageIssueTree,
  assumptions: StageAssumptions,
  evidence: StageEvidence,
  benchmark: StageBenchmark,
  country: StageCountry,
  model: StageModel,
  storyline: StageStoryline,
  document: StageDocument,
  arabic: StageArabic,
  gallery: StageGallery,
  failed: StageFailed,
};

const STATUS_PILL = {
  idle: 'Ready', interpreting: 'Interpreting', planning: 'Planning',
  waiting_for_user: 'Waiting for you', executing: 'Executing',
  verifying: 'Verifying', revising: 'Revising', completed: 'Completed',
  failed: 'Failed', cancelled: 'Cancelled',
};

export default function Canvas({ run, resolveGate, fetchArtifact }) {
  const stage = activeStage(run);
  const Renderer = RENDERERS[stage] || null;
  const gate = (run.gates || []).find((g) => g.status === 'open') || null;
  const artifact = stageArtifact(run, stage);
  const [artifactContent, setArtifactContent] = useState(null);

  // Fetch the full content of the stage artifact when it changes (previews are
  // truncated server-side). Content is REAL artifact state — never synthesised.
  useEffect(() => {
    let alive = true;
    setArtifactContent(null);
    if (artifact?.artifactId && fetchArtifact) {
      fetchArtifact(artifact.artifactId).then((full) => { if (alive && full) setArtifactContent(full); });
    }
    return () => { alive = false; };
  }, [artifact?.artifactId, artifact?.status, fetchArtifact]);

  if (stage === 'idle') {
    return (
      <div className="oda-canvas">
        <div className="oda-empty">
          <div className="oda-kicker">ODA Workspace</div>
          <h2 className="oda-h" style={{ fontSize: 22, margin: '10px 0 6px' }}>What are we producing today?</h2>
          <p className="oda-muted" style={{ maxWidth: 480, margin: '0 auto' }}>
            Describe the deliverable in the composer — a briefing deck, a structured problem,
            a benchmark, a country pack, a translation. The canvas follows the run live.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="oda-canvas">
      <div className="oda-canvas-head">
        <div>
          <div className="oda-kicker">{STAGE_LABELS[stage] || stage}</div>
          {run.safeStatus && !['completed', 'failed'].includes(run.status) && (
            <div className="oda-muted" style={{ fontSize: 12.5, marginTop: 2 }}>{run.safeStatus}</div>
          )}
        </div>
        <span className={`oda-pill oda-pill--${run.status}`}>{STATUS_PILL[run.status] || run.status}</span>
      </div>
      {Renderer && (
        <Renderer
          run={run}
          stage={stage}
          gate={gate}
          artifact={artifact}
          artifactContent={artifactContent}
          onResolveGate={resolveGate}
          fetchArtifact={fetchArtifact}
        />
      )}
    </div>
  );
}
