/**
 * Private log-record contract for auto-approve evaluator decisions.
 *
 * One record per actual model attempt. Cache hits are never logged, and
 * rendered prompts and standard extension guidance are never recorded — only
 * the inputs that drove the decision. Persisting is best-effort: a record that
 * fails to write is simply lost, since a failed write cannot record its own
 * discard. `accepted` means the verdict was applied; `discarded` means the
 * attempt was valid but its verdict went unused (e.g. session guidance changed
 * mid-flight). Log-file location and opt-in mechanics live in the extension.
 *
 * Also the shared field shapes (verdict, effort, guidance snapshot) for the
 * benchmark contracts in benchmark/auto-approve/contracts.ts.
 */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const EVAL_LOG_SCHEMA_VERSION = 1;

export const verdictSchema = Type.Union([Type.Literal("allow"), Type.Literal("review")]);
export const effortSchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);

/** Session-guidance snapshot; the null form records that no guidance applied. */
export const guidanceSchema = Type.Object(
	{
		text: Type.String(),
		revision: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export const guidanceSnapshotSchema = Type.Union([guidanceSchema, Type.Null()]);

export const evalLogRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(EVAL_LOG_SCHEMA_VERSION),
		/** Epoch milliseconds when the attempt completed. */
		timestamp: Type.Number({ minimum: 0 }),
		tool: Type.String({ minLength: 1 }),
		input: Type.Record(Type.String(), Type.Unknown()),
		cwd: Type.String({ minLength: 1 }),
		/** The roots and instruction list actually passed to the evaluator. */
		structuredContext: Type.Object(
			{
				writeRoots: Type.Array(Type.String()),
				readRoots: Type.Array(Type.String()),
				instructions: Type.Array(Type.String()),
			},
			{ additionalProperties: false },
		),
		guidance: guidanceSnapshotSchema,
		/** Provenance of the model that produced the attempt. */
		model: Type.Object(
			{
				provider: Type.String({ minLength: 1 }),
				model: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		/** Version of the pi-extensions package that produced the decision. */
		evaluatorVersion: Type.String({ minLength: 1 }),
		effort: effortSchema,
		timeoutMs: Type.Number({ exclusiveMinimum: 0 }),
		decision: verdictSchema,
		reason: Type.String(),
		/** False only for synthetic fallback results caused by evaluator failure. */
		cacheable: Type.Boolean(),
		attempt: Type.Object(
			{
				/** Raw model stop reason, captured before fallback; null when the attempt produced none. */
				stopReason: Type.Union([Type.String(), Type.Null()]),
			},
			{ additionalProperties: false },
		),
		elapsedMs: Type.Number({ minimum: 0 }),
		status: Type.Union([Type.Literal("accepted"), Type.Literal("discarded")]),
	},
	{ additionalProperties: false },
);

export type EvalLogRecord = Static<typeof evalLogRecordSchema>;

export function isEvalLogRecord(value: unknown): value is EvalLogRecord {
	return Value.Check(evalLogRecordSchema, value);
}
