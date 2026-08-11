// ─── Memory constants ────────────────────────────────────────────

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

const REFLECT_EVERY = 50;
const REFLECT_COOLDOWN_MS = 120000; // 2 minutes

// Era consolidation: every ERA_EVERY reflections (~ERA_EVERY×REFLECT_EVERY
// interactions), condense that stretch of journal into one "chapter"; keep the
// last ERA_KEEP chapters on the IDENTITY item so medium-term autobiography
// survives the small journal context window.
const ERA_EVERY = 10;
const ERA_KEEP = 3;

export { ERA_EVERY, ERA_KEEP, REFLECT_COOLDOWN_MS, REFLECT_EVERY, TABLE_NAME };
