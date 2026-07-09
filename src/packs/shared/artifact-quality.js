export async function runArtifactQualityPipeline({ artifact, input, prepare, generate, verify }) {
  const timingsMs = {};
  const start = Date.now();
  const prepared = await timeStep(timingsMs, 'prepare', async () => {
    if (!prepare) return { input, repairs: [] };
    const r = await prepare(input);
    return {
      input: Object.prototype.hasOwnProperty.call(r || {}, 'input') ? r.input : r?.slides,
      repairs: Array.isArray(r?.repairs) ? r.repairs : [],
    };
  });
  const result = await timeStep(timingsMs, 'generate', () => generate(prepared.input));
  const verification = await timeStep(timingsMs, 'verify', () => verify ? verify(result) : result?.verify);
  timingsMs.total = Date.now() - start;
  return {
    result,
    verification,
    quality: summarizeArtifactQuality({ artifact, verification, repairs: prepared.repairs, timingsMs }),
  };
}

function summarizeArtifactQuality({ artifact, verification, repairs, timingsMs }) {
  const structureOk = verification?.ok !== false;
  const designOk = verification?.design?.ok !== false;
  const score = typeof verification?.design?.score === 'number' ? verification.design.score : (structureOk ? 100 : 0);
  const issues = [
    ...(Array.isArray(verification?.issues) ? verification.issues : []),
    ...(Array.isArray(verification?.design?.issues) ? verification.design.issues : []),
  ];
  const ok = structureOk && designOk;
  return {
    artifact,
    ok,
    grade: ok ? 'pass' : structureOk ? 'needs-repair' : 'invalid',
    score,
    structureOk,
    designOk,
    issueCount: issues.length,
    repairCount: repairs.length,
    repaired: repairs.length > 0,
    repairs,
    timingsMs,
  };
}

async function timeStep(timingsMs, name, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timingsMs[name] = Date.now() - start;
  }
}
